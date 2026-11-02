import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host
beforeEach(async () => { host = await startRuntime() })
afterEach(async () => { await host.stop() })

const command = () => host.commands.get('team')!

describe('/team', () => {
  it('registers the command and runs a durable six-role team from the main Session', async () => {
    await vi.waitFor(() => expect(command()).toBeDefined())
    const result = command().handler({ agent: host.agents.get(host.runtime.masterId), rawInput: 'Add a health endpoint' }) as { kind: string; text: string }
    expect(result).toMatchObject({ kind: 'success' })
    expect(result.text).toMatch(/^Team team-/)
    await vi.waitFor(() => expect(host.runtime.teams.list()[0]?.state).toBe('done'))
    const team = host.runtime.teams.list()[0]!
    expect(team.members.map(member => member.role)).toEqual(['lead', 'researcher', 'developer', 'tester', 'reviewer', 'ops'])
    expect(team.members.every(member => member.state === 'done')).toBe(true)
    expect(team.summary).toContain('Team lead done')
    expect(host.runtime.teams.get(team.id)?.parent_session_id).toBe(host.runtime.masterId)
    expect((await host.api('GET', 'teams')).body.items).toHaveLength(1)
  })

  it('reports status, refuses while paused, and stops a running team', async () => {
    await vi.waitFor(() => expect(command()).toBeDefined())
    const agent = host.agents.get(host.runtime.masterId)
    expect(command().handler({ agent, rawInput: 'status' })).toMatchObject({ kind: 'success', text: 'No teams yet' })
    const settings = host.runtime.store.settings()
    host.runtime.store.saveSettings({ ...settings, paused: true })
    expect(command().handler({ agent, rawInput: 'work' })).toMatchObject({ kind: 'error' })
    host.runtime.store.saveSettings({ ...settings, paused: false })
    host.subagents.service.startActivation.mockImplementation(async () => ({ childId: 'held-child',
      result: new Promise(() => {}), dispose: async () => {} }))
    const started = command().handler({ agent, rawInput: 'long task' }) as { text: string }
    const id = /team-[a-f0-9]+/.exec(started.text)![0]
    expect(command().handler({ agent, rawInput: `stop ${id}` })).toMatchObject({ kind: 'success' })
    expect(host.runtime.teams.get(id)?.state).toBe('stopped')
  })
})
