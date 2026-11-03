import { describe, expect, it, vi } from 'vitest'
import { SettingsSchema, type Settings } from '../src/policy.ts'
import { Teams, TEAM_ROLES, type TeamsHost } from '../src/app/teams.ts'

const settings = (paused = false) => SettingsSchema.parse({ paused, executor: { profiles: {
  lead: { model: { provider: 'anthropic-gateway', model: 'claude-opus-5-5' }, instructions: 'Lead carefully.' },
  developer: { model: { provider: 'llm-center', model: 'deepseek-v4.1-flash-mb' } },
}, defaultProfile: 'developer' } })

function bench(options: { paused?: boolean; pending?: boolean; modalities?: readonly string[]; custom?: Settings } = {}) {
  const values = new Map<string, unknown>()
  const runs: { label: string; prompt: string; blocks: readonly { type: string; text?: string }[]; agentOptions?: unknown; preset?: string
    signal: AbortSignal }[] = []
  const subagents = { startActivation: vi.fn(async (spec: { label: string; request: { prompt: { type: string; text?: string }[]; agentOptions?: unknown
    agentPreset?: string }; signal: AbortSignal }) => {
    runs.push({ label: spec.label, prompt: spec.request.prompt.map(block => block.text).join(''), blocks: spec.request.prompt,
      agentOptions: spec.request.agentOptions, preset: spec.request.agentPreset, signal: spec.signal })
    const result = options.pending ? new Promise<never>(() => {}) : Promise.resolve({ output: [{ type: 'text', text: `${spec.label} result` }],
      stopReason: 'completed' as const })
    return { childId: `child-${runs.length}`, result, dispose: async () => {} }
  }) }
  const llm = { resolveModelInfo: vi.fn(async (_provider: string, _model: string) =>
    options.modalities === undefined ? {} : { inputModalities: options.modalities }) }
  const host: TeamsHost = { context: { subagents, llm } as never, masterId: 'master', stateDir: '/tmp/team-state',
    settings: () => options.custom ?? settings(options.paused), logger: { warn: () => {} }, store: { get: key => values.get(key) as never,
      set: (key, value) => { values.set(key, value) }, atomic: <T>(run: () => T) => run() } }
  return { teams: new Teams(host), runs, subagents, llm }
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
    expect(teams.list()[0]).toMatchObject({ id: team.id, state: 'done' })
    expect(teams.activeCount).toBe(0)
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
