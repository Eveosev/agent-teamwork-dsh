import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SettingsSchema, type Settings } from '../src/policy.ts'
import { Teams, TEAM_ROLES, type TeamsHost } from '../src/app/teams.ts'
import { KV } from '../src/kv.ts'

const settings = (paused = false) => SettingsSchema.parse({ paused, executor: { profiles: {
  lead: { model: { provider: 'anthropic-gateway', model: 'claude-opus-5-5' }, instructions: 'Lead carefully.' },
  developer: { model: { provider: 'llm-center', model: 'deepseek-v4.1-flash-mb' } },
}, defaultProfile: 'developer' } })

function bench(options: { paused?: boolean; pending?: boolean; modalities?: readonly string[]; custom?: Settings
  failFirst?: boolean; alwaysFail?: boolean; usage?: { input: number; output: number; cached: number }
  liveUsage?: { input: number; output: number; cached: number }; badSessions?: boolean } = {}) {
  const values = new Map<string, unknown>()
  const attempts = new Map<string, number>()
  const usageListeners: ((session: { id: string }, event: { type: string; usage?: Record<string, number> }) => void)[] = []
  const runs: { label: string; prompt: string; blocks: readonly { type: string; text?: string }[]; agentOptions?: unknown; preset?: string
    signal: AbortSignal }[] = []
  const subagents = { startActivation: vi.fn(async (spec: { label: string; request: { prompt: { type: string; text?: string }[]; agentOptions?: unknown
    agentPreset?: string }; signal: AbortSignal }) => {
    runs.push({ label: spec.label, prompt: spec.request.prompt.map(block => block.text).join(''), blocks: spec.request.prompt,
      agentOptions: spec.request.agentOptions, preset: spec.request.agentPreset, signal: spec.signal })
    const role = spec.label.split(' · ')[1] ?? ''
    const attempt = (attempts.get(role) ?? 0) + 1; attempts.set(role, attempt)
    const verdict = role !== 'Tester' && role !== 'Reviewer' ? '' : options.alwaysFail || options.failFirst && attempt === 1 ? '\n\nVERDICT: FAIL'
      : '\n\nVERDICT: PASS'
    const output = { output: [{ type: 'text', text: `${spec.label} result${verdict}` }], stopReason: 'completed' as const }
    const childId = `child-${runs.length}`
    const result = options.pending ? new Promise<never>(() => {}) : options.liveUsage ? new Promise<typeof output>(resolve => {
      setTimeout(() => {
        for (const listener of usageListeners) listener({ id: childId }, { type: 'assistant/message', usage: {
          inputTokens: options.liveUsage!.input, outputTokens: options.liveUsage!.output, cacheReadTokens: options.liveUsage!.cached } })
        resolve(output)
      }, 0)
    }) : Promise.resolve(output)
    return { childId, result, dispose: async () => {} }
  }) }
  const llm = { resolveModelInfo: vi.fn(async (_provider: string, _model: string) =>
    options.modalities === undefined ? {} : { inputModalities: options.modalities }) }
  const agents = options.usage ? { get: () => ({ session: { snapshotEvents: () => [{ type: 'assistant/message',
    usage: { inputTokens: options.usage!.input, outputTokens: options.usage!.output, cacheReadTokens: options.usage!.cached } }] } }) } : undefined
  const context: Record<string, unknown> = { subagents, llm, ...agents ? { agents } : {},
    ...options.liveUsage ? { on: (_event: string, listener: (session: { id: string }, event: { type: string; usage?: Record<string, number> }) => void) =>
      usageListeners.push(listener) } : {} }
  if (options.badSessions) Object.defineProperty(context, 'sessions', {
    get: () => { throw new Error('cannot get property "sessions" without inject') } })
  const host: TeamsHost = { context: context as never, masterId: 'master', stateDir: '/tmp/team-state',
    settings: () => options.custom ?? settings(options.paused), logger: { warn: () => {} }, store: { get: key => values.get(key) as never,
      set: (key, value) => { values.set(key, value) }, delete: key => { values.delete(key) }, atomic: <T>(run: () => T) => run() } }
  return { teams: new Teams(host), runs, subagents, llm, store: host.store }
}
const parent = { id: 'master' } as never
/** A model-visible image block; the bench never inspects its bytes, only where it lands in each prompt. */
const image = (id: string) => ({ type: 'image', attachment: { id } }) as never

describe('Teams', () => {
  it('runs the six roles in order, gives each its profile model, and stores the summary', async () => {
    const { teams, runs } = bench()
    const team = teams.create('Add a health endpoint', parent)
    await vi.waitFor(() => expect(teams.get(team.id)?.state).toBe('done'))
    expect(runs.map(run => run.label.split(' · ')[1])).toEqual(['Team lead', 'Researcher', 'Developer', 'Tester', 'Reviewer', 'Ops', 'Team lead'])
    expect(runs[2]!.agentOptions).toEqual({ provider: 'llm-center', model: 'deepseek-v4.1-flash-mb' })
    expect(runs[0]!.agentOptions).toEqual({ provider: 'anthropic-gateway', model: 'claude-opus-5-5' })
    expect(runs[0]!.prompt).toContain('Lead carefully.')
    expect(runs[2]!.prompt).toContain('Plan:')
    expect(runs[4]!.prompt).toContain('## Developer')
    const stored = teams.get(team.id)!
    expect(stored.members.map(member => member.role)).toEqual([...TEAM_ROLES])
    expect(stored.members.every(member => member.state === 'done')).toBe(true)
    expect(stored.summary).toContain('Team lead result')
    expect(stored.outcome).toBe('achieved')
    expect(stored.rounds).toBe(1)
    expect(stored.members.find(member => member.role === 'tester')?.verdict).toBe('pass')
    expect(stored.members.find(member => member.role === 'reviewer')?.verdict).toBe('pass')
    const leadRuns = stored.members.find(member => member.role === 'lead')?.runs ?? []
    expect(leadRuns.map(run => [run.round, run.source])).toEqual([[1, 'task'], [1, 'all-roles']])
    expect(leadRuns.every(run => run.state === 'done' && run.session_id)).toBe(true)
    expect(stored.members.find(member => member.role === 'tester')?.runs?.map(run => run.source)).toEqual(['implementation'])
    expect(teams.list()[0]).toMatchObject({ id: team.id, state: 'done' })
    expect(teams.activeCount).toBe(0)
  })

  it('continues a finished team in place with its previous evidence', async () => {
    const { teams, runs } = bench()
    const first = teams.create('Finish the Chrome extension', parent)
    await vi.waitFor(() => expect(teams.get(first.id)?.state).toBe('done'))
    const before = teams.get(first.id)!
    const shots = [image('continuation-shot')]
    const next = teams.continueTeam(first.id, parent, 'Fix the remaining tab grouping issue', shots)
    expect(next.id).toBe(first.id)
    await vi.waitFor(() => expect(teams.get(first.id)?.state).toBe('done'))
    const stored = teams.get(first.id)!
    expect(stored).toMatchObject({ task: first.task, title: first.title, directory: first.directory,
      continuations: 1, previous_summary: before.summary, previous_outcome: 'achieved',
      continuation: 'Fix the remaining tab grouping issue', continuation_recipients: [...TEAM_ROLES], outcome: 'achieved' })
    expect(stored.continued_from).toBeUndefined()
    expect(stored.summary).toContain('Team lead result')
    expect(teams.list()).toHaveLength(1)
    expect(teams.list()[0]?.id).toBe(first.id)
    expect(runs).toHaveLength(14)
    for (const run of runs.slice(7)) expect(run.blocks.slice(1)).toEqual(shots)
    expect(runs[7]!.prompt).toContain('Previous attempt evidence:')
    expect(runs[7]!.prompt).toContain(before.summary!)
    expect(runs[7]!.prompt).toContain('Fix the remaining tab grouping issue')
    expect(runs[9]!.prompt).toContain('instead of starting over')
    for (const run of runs.slice(7)) expect(run.prompt).toContain('Fix the remaining tab grouping issue')
  })

  it('shows only the latest card in a legacy continuation lineage', async () => {
    const { teams, store } = bench()
    const parentTeam = teams.create('Legacy parent', parent)
    await vi.waitFor(() => expect(teams.get(parentTeam.id)?.state).toBe('done'))
    const child = teams.create('Legacy child', parent)
    await vi.waitFor(() => expect(teams.get(child.id)?.state).toBe('done'))
    const record = teams.get(child.id)!
    record.continued_from = parentTeam.id
    store.set(KV.teams.record(child.id), record)
    expect(teams.list().map(team => team.id)).toEqual([child.id])
    expect(teams.get(parentTeam.id)).toBeDefined()
  })

  it('refuses to continue a running team or an unknown team', async () => {
    const { teams, runs } = bench({ pending: true })
    const team = teams.create('Still running', parent)
    await vi.waitFor(() => expect(runs.length).toBeGreaterThan(0))
    expect(() => teams.continueTeam(team.id, parent)).toThrow('still running')
    expect(() => teams.continueTeam('missing', parent)).toThrow('Team not found')
    expect(() => teams.remove(team.id)).toThrow('Stop the team before deleting it')
    teams.stop(team.id)
  })

  it('deletes a team card and its continuation lineage', async () => {
    const { teams, store } = bench()
    const parentTeam = teams.create('Delete parent', parent)
    await vi.waitFor(() => expect(teams.get(parentTeam.id)?.state).toBe('done'))
    const child = teams.create('Delete child', parent)
    await vi.waitFor(() => expect(teams.get(child.id)?.state).toBe('done'))
    const record = teams.get(child.id)!
    record.continued_from = parentTeam.id
    store.set(KV.teams.record(child.id), record)
    expect(teams.remove('missing')).toBe(false)
    expect(teams.remove(child.id)).toBe(true)
    expect(teams.get(child.id)).toBeUndefined()
    expect(teams.get(parentTeam.id)).toBeUndefined()
    expect(teams.list()).toEqual([])
  })

  it('re-dispatches a failed verification through the lead and passes on the next round', async () => {
    const { teams, runs } = bench({ failFirst: true })
    const team = teams.create('Add the settings page', parent)
    await vi.waitFor(() => expect(teams.get(team.id)?.state).toBe('done'))
    expect(runs.map(run => run.label.split(' · ')[1])).toEqual(['Team lead', 'Researcher', 'Developer', 'Tester', 'Reviewer',
      'Team lead', 'Developer', 'Tester', 'Reviewer', 'Ops', 'Team lead'])
    expect(runs[5]!.prompt).toContain('Write concise repair instructions')
    expect(runs[6]!.prompt).toContain('Lead repair instructions:')
    const stored = teams.get(team.id)!
    expect(stored.outcome).toBe('achieved')
    expect(stored.rounds).toBe(2)
    expect(stored.members.find(member => member.role === 'developer')?.round).toBe(2)
    expect(stored.members.find(member => member.role === 'tester')?.verdict).toBe('pass')
  })

  it('marks a team whose verification never passes as not achieved after the round limit', async () => {
    const { teams, runs } = bench({ alwaysFail: true })
    const team = teams.create('Never passes', parent)
    await vi.waitFor(() => expect(teams.get(team.id)?.state).toBe('done'))
    expect(teams.get(team.id)?.outcome).toBe('not_achieved')
    expect(teams.get(team.id)?.rounds).toBe(3)
    expect(runs).toHaveLength(15)
  })

  it('stops at the configured max rounds instead of the default', async () => {
    const custom = SettingsSchema.parse({ ...settings(), executor: { ...settings().executor, maxRounds: 2 } })
    const { teams, runs } = bench({ alwaysFail: true, custom })
    const team = teams.create('Configured limit', parent)
    await vi.waitFor(() => expect(teams.get(team.id)?.state).toBe('done'))
    expect(teams.get(team.id)?.outcome).toBe('not_achieved')
    expect(teams.get(team.id)?.rounds).toBe(2)
    expect(runs).toHaveLength(11)
  })

  it('does not fail a role when session usage cannot be read', async () => {
    const { teams } = bench({ badSessions: true })
    const team = teams.create('Finish without usage fallback', parent)
    await vi.waitFor(() => expect(teams.get(team.id)?.state).toBe('done'))
    expect(teams.get(team.id)).toMatchObject({ state: 'done', outcome: 'achieved' })
    expect(teams.get(team.id)?.members.every(member => member.state === 'done')).toBe(true)
  })

  it('collects token usage from live child session events without double-counting', async () => {
    const { teams } = bench({ liveUsage: { input: 100, output: 40, cached: 60 } })
    const team = teams.create('Measure live tokens', parent)
    await vi.waitFor(() => expect(teams.get(team.id)?.state).toBe('done'))
    const stored = teams.get(team.id)!
    expect(stored.members.find(member => member.role === 'lead')?.usage).toEqual({ input: 200, output: 80, cached: 120 })
    expect(stored.members.find(member => member.role === 'tester')?.usage).toEqual({ input: 100, output: 40, cached: 60 })
    expect(stored.usage).toEqual({ input: 700, output: 280, cached: 420 })
  })

  it('sums input, output and cached tokens per role and for the team', async () => {
    const { teams } = bench({ usage: { input: 100, output: 40, cached: 60 } })
    const team = teams.create('Measure tokens', parent)
    await vi.waitFor(() => expect(teams.get(team.id)?.state).toBe('done'))
    const stored = teams.get(team.id)!
    expect(stored.members.every(member => member.usage)).toBe(true)
    expect(stored.members.find(member => member.role === 'lead')?.usage).toEqual({ input: 200, output: 80, cached: 120 })
    expect(stored.usage).toEqual({ input: 700, output: 280, cached: 420 })
    expect(teams.list()[0]?.usage).toEqual({ input: 700, output: 280, cached: 420 })
  })

  it('requires the reviewer to provide screenshot evidence for visually verifiable design', async () => {
    const { teams, runs } = bench()
    const team = teams.create('Review the new settings page design', parent)
    await vi.waitFor(() => expect(teams.get(team.id)?.state).toBe('done'))
    const reviewer = runs.find(run => run.label.endsWith('Reviewer'))!
    expect(reviewer.prompt).toContain('product or feature design')
    expect(reviewer.prompt).toContain('real screenshot')
    expect(reviewer.prompt).toContain('mark the visual acceptance check unverified')
  })

  it('refuses to start while processing is paused', () => {
    const { teams } = bench({ paused: true })
    expect(() => teams.create('task', parent)).toThrow('Processing is paused')
  })

  it('sends attached images after the text block to every role, including both lead runs', async () => {
    const { teams, runs } = bench()
    const images = [image('one'), image('two')]
    const team = teams.create('Describe the screenshots', parent, '', undefined, images)
    await vi.waitFor(() => expect(teams.get(team.id)?.state).toBe('done'))
    expect(runs).toHaveLength(7)
    for (const run of runs) {
      expect(run.blocks[0]).toMatchObject({ type: 'text' })
      expect(run.blocks.slice(1)).toEqual(images)
    }
    // Team records stay text-only: the image references only live in the run's prompts.
    const stored = teams.get(team.id)!
    expect(stored.task).toBe('Describe the screenshots')
    expect(JSON.stringify(stored)).not.toContain('attachment')
  })

  it('sends images only to the roles whose own model accepts them', async () => {
    const custom = SettingsSchema.parse({ executor: { profiles: {
      lead: { model: { provider: 'anthropic-gateway', model: 'vision-model' } },
      developer: { model: { provider: 'llm-center', model: 'text-only-model' } },
    }, defaultProfile: 'developer' } })
    const { teams, runs, llm } = bench({ custom })
    llm.resolveModelInfo.mockImplementation(async (_provider: string, model: string) => ({
      inputModalities: model === 'vision-model' ? ['text', 'image'] : ['text'] }))
    const images = [image('one')]
    const team = teams.create('Describe the screenshot', parent, '', undefined, images)
    await vi.waitFor(() => expect(teams.get(team.id)?.state).toBe('done'))
    expect(runs).toHaveLength(7)
    // The lead profile uses the vision model; every other role inherits the text-only developer profile.
    expect(runs.filter(run => run.blocks.length > 1).map(run => run.label.split(' · ')[1])).toEqual(['Team lead', 'Team lead'])
    for (const run of runs) {
      if (run.blocks.length > 1) expect(run.blocks.slice(1)).toEqual(images)
      else expect(run.prompt).toContain('omitted: this role\'s model does not accept image input')
    }
    expect(llm.resolveModelInfo).toHaveBeenCalledWith('anthropic-gateway', 'vision-model', expect.any(AbortSignal))
    expect(llm.resolveModelInfo).toHaveBeenCalledWith('llm-center', 'text-only-model', expect.any(AbortSignal))
  })

  it('omits images from a role whose model explicitly rejects them and says so in its prompt', async () => {
    const { teams, runs, llm } = bench({ modalities: ['text'] })
    const images = [image('one')]
    const team = teams.create('Describe the screenshot', parent, '', undefined, images)
    await vi.waitFor(() => expect(teams.get(team.id)?.state).toBe('done'))
    expect(llm!.resolveModelInfo).toHaveBeenCalled()
    expect(runs).toHaveLength(7)
    for (const run of runs) {
      expect(run.blocks).toHaveLength(1)
      expect(run.prompt).toContain('omitted: this role\'s model does not accept image input')
    }
  })

  it('reads only image or text files inside the team directory', async () => {
    const { teams } = bench()
    const team = teams.create('Collect evidence', parent)
    await vi.waitFor(() => expect(teams.get(team.id)?.state).toBe('done'))
    writeFileSync(join(team.directory, 'shot.png'), Buffer.from('png'))
    writeFileSync(join(team.directory, 'notes.md'), 'hello')
    writeFileSync('/tmp/team-state/secret.txt', 'outside')
    const image = teams.readFile(team.id, 'shot.png')
    expect(image).toMatchObject({ name: 'shot.png', mime: 'image/png' })
    expect(Buffer.from(image!.data, 'base64').toString()).toBe('png')
    expect(teams.readFile(team.id, 'notes.md')).toMatchObject({ name: 'notes.md', mime: 'text/markdown; charset=utf-8' })
    expect(teams.readFile(team.id, '../secret.txt')).toBeUndefined()
    expect(teams.readFile(team.id, '/tmp/team-state/secret.txt')).toBeUndefined()
  })

  it('stops a running team, aborting its signal and recording stopped members', async () => {
    const { teams, runs } = bench({ pending: true })
    const team = teams.create('task', parent)
    await vi.waitFor(() => expect(runs.length).toBeGreaterThan(0))
    expect(teams.stop(team.id)).toBe(true)
    await vi.waitFor(() => expect(teams.get(team.id)?.state).toBe('stopped'))
    expect(runs[0]!.signal.aborted).toBe(true)
    expect(teams.get(team.id)?.members[0]!.state).toBe('stopped')
  })
})
