import { describe, expect, it, vi } from 'vitest'
import { SettingsSchema } from '../src/policy.ts'
import { Teams, TEAM_ROLES, type TeamsHost } from '../src/app/teams.ts'

const settings = (paused = false) => SettingsSchema.parse({ paused, executor: { profiles: {
  lead: { model: { provider: 'anthropic-gateway', model: 'claude-opus-5-5' }, instructions: 'Lead carefully.' },
  developer: { model: { provider: 'llm-center', model: 'deepseek-v4.1-flash-mb' } },
}, defaultProfile: 'developer' } })

function bench(options: { paused?: boolean; pending?: boolean } = {}) {
  const values = new Map<string, unknown>()
  const runs: { label: string; prompt: string; agentOptions?: unknown; preset?: string; signal: AbortSignal }[] = []
  const subagents = { startActivation: vi.fn(async (spec: { label: string; request: { prompt: { type: string; text?: string }[]; agentOptions?: unknown
    agentPreset?: string }; signal: AbortSignal }) => {
    runs.push({ label: spec.label, prompt: spec.request.prompt.map(block => block.text).join(''), agentOptions: spec.request.agentOptions,
      preset: spec.request.agentPreset, signal: spec.signal })
    const result = options.pending ? new Promise<never>(() => {}) : Promise.resolve({ output: [{ type: 'text', text: `${spec.label} result` }],
      stopReason: 'completed' as const })
    return { childId: `child-${runs.length}`, result, dispose: async () => {} }
  }) }
  const host: TeamsHost = { context: { subagents } as never, masterId: 'master', stateDir: '/tmp/team-state', settings: () => settings(options.paused),
    logger: { warn: () => {} }, store: { get: key => values.get(key) as never, set: (key, value) => { values.set(key, value) },
      atomic: <T>(run: () => T) => run() } }
  return { teams: new Teams(host), runs, subagents }
}
const parent = { id: 'master' } as never

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

  it('refuses to start while processing is paused', () => {
    const { teams } = bench({ paused: true })
    expect(() => teams.create('task', parent)).toThrow('Processing is paused')
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
