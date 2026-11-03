import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host
beforeEach(async () => { host = await startRuntime() })
afterEach(async () => { await host.stop() })

const command = () => host.commands.get('team')!
/** An admitted image block; the runtime only forwards it, so a minimal durable reference is enough. */
const image = (id: string) => ({ type: 'image', attachment: { id } }) as never
/** The prompts every role activation received, in start order. */
const prompts = () => vi.mocked(host.subagents.service.startActivation).mock.calls
  .map(([spec]) => (spec as unknown as { request: { prompt: { type: string }[] } }).request.prompt)

describe('/team', () => {
  it('registers the command and runs a durable six-role team from the main Session', async () => {
    await vi.waitFor(() => expect(command()).toBeDefined())
    expect(command().input).toMatchObject({ attachments: true })
    const result = command().handler({ agent: host.agents.get(host.runtime.masterId), rawInput: 'Add a health endpoint' }) as { kind: string; text: string }
    expect(result).toMatchObject({ kind: 'success' })
    expect(result.text).toMatch(/^Team team-/)
    expect(result.text).not.toContain('attached')
    await vi.waitFor(() => expect(host.runtime.teams.list()[0]?.state).toBe('done'))
    const team = host.runtime.teams.list()[0]!
    expect(team.members.map(member => member.role)).toEqual(['lead', 'researcher', 'developer', 'tester', 'reviewer', 'ops'])
    expect(team.members.every(member => member.state === 'done')).toBe(true)
    expect(team.summary).toContain('Team lead done')
    expect(host.runtime.teams.get(team.id)?.parent_session_id).toBe(host.runtime.masterId)
    expect((await host.api('GET', 'teams')).body.items).toHaveLength(1)
    // The text-only path is unchanged: every prompt is one text block with no image.
    expect(prompts()).toHaveLength(7)
    for (const prompt of prompts()) expect(prompt.map(block => block.type)).toEqual(['text'])
  })

  it('accepts images, sends them to every role after the text, and supports image-only input', async () => {
    await vi.waitFor(() => expect(command()).toBeDefined())
    const images = [image('one'), image('two')]
    const started = await command().handler({ agent: host.agents.get(host.runtime.masterId), rawInput: '', attachments: images }) as { kind: string; text: string }
    expect(started).toMatchObject({ kind: 'success' })
    expect(started.text).toContain('(2 images attached)')
    expect(started.text).toContain(': Image task')
    await vi.waitFor(() => expect(host.runtime.teams.list()[0]?.state).toBe('done'))
    const team = host.runtime.teams.list()[0]!
    expect(team.title).toBe('Image task')
    expect(host.runtime.teams.get(team.id)?.task).toBe('Work from the attached images.')
    // Image references reach the role prompts but never the durable team record.
    expect(JSON.stringify(host.runtime.teams.get(team.id))).not.toContain('attachment')
    expect(prompts()).toHaveLength(7)
    for (const prompt of prompts()) {
      expect(prompt[0]).toMatchObject({ type: 'text' })
      expect(prompt.slice(1)).toEqual(images)
    }
  })

  it('accepts one image with task text, keeps the text task, and honors --dir', async () => {
    await vi.waitFor(() => expect(command()).toBeDefined())
    const directory = join(host.directory, 'attached-team')
    const images = [image('one')]
    const started = await command().handler({ agent: host.agents.get(host.runtime.masterId),
      rawInput: `--dir ${directory} Describe the screenshot`, attachments: images }) as { kind: string; text: string }
    expect(started).toMatchObject({ kind: 'success' })
    expect(started.text).toContain('(1 image attached)')
    await vi.waitFor(() => expect(host.runtime.teams.list()[0]?.state).toBe('done'))
    const team = host.runtime.teams.list()[0]!
    expect(host.runtime.teams.get(team.id)).toMatchObject({ task: 'Describe the screenshot', title: 'Describe the screenshot', directory })
    expect(prompts()).toHaveLength(7)
    for (const prompt of prompts()) {
      expect(prompt[0]).toMatchObject({ type: 'text' })
      expect((prompt[0] as { text?: string }).text).toContain('Describe the screenshot')
      expect(prompt.slice(1)).toEqual(images)
    }
  })

  it('rejects images when the lead model declares no image input and starts no team', async () => {
    await vi.waitFor(() => expect(command()).toBeDefined())
    const settings = host.runtime.store.settings()
    host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, model: { provider: 'llm-center', model: 'text-only' } } })
    host.llm.resolveModelInfo.mockResolvedValueOnce({ inputModalities: ['text'] })
    const result = await command().handler({ agent: host.agents.get(host.runtime.masterId), rawInput: 'Describe this', attachments: [image('one')] }) as
      { kind: string; text: string }
    expect(result).toMatchObject({ kind: 'error' })
    expect(result.text).toContain('text-only')
    expect(result.text).toContain('does not support image input')
    expect(host.runtime.teams.list()).toHaveLength(0)
  })

  it('starts when the catalog does not declare the lead model modalities', async () => {
    await vi.waitFor(() => expect(command()).toBeDefined())
    const settings = host.runtime.store.settings()
    host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, model: { provider: 'llm-center', model: 'undeclared' } } })
    host.llm.resolveModelInfo.mockResolvedValueOnce({})
    const result = await command().handler({ agent: host.agents.get(host.runtime.masterId), rawInput: 'Describe this',
      attachments: [image('one')] }) as { kind: string; text: string }
    expect(result).toMatchObject({ kind: 'success' })
    expect(result.text).toContain('(1 image attached)')
    await vi.waitFor(() => expect(host.runtime.teams.list()[0]?.state).toBe('done'))
    expect(host.runtime.teams.list()).toHaveLength(1)
  })

  it('rejects attachment misuse without creating a team', async () => {
    await vi.waitFor(() => expect(command()).toBeDefined())
    const agent = host.agents.get(host.runtime.masterId)
    expect(await command().handler({ agent, rawInput: 'status', attachments: [image('one')] }))
      .toMatchObject({ kind: 'error', text: '/team status does not accept attachments' })
    expect(await command().handler({ agent, rawInput: 'stop team-abc', attachments: [image('one')] }))
      .toMatchObject({ kind: 'error', text: '/team stop does not accept attachments' })
    expect(await command().handler({ agent, rawInput: 'task', attachments: [{ type: 'file' }] }))
      .toMatchObject({ kind: 'error', text: '/team accepts images as attachments only; remove the file attachment and retry' })
    expect(await command().handler({ agent, rawInput: '' })).toMatchObject({ kind: 'error' })
    expect(host.runtime.teams.list()).toHaveLength(0)
  })

  it('creates, reads and stops teams through the panel API', async () => {
    const created = await host.api('POST', 'teams', { task: 'API task', title: 'API team', directory: '/tmp/api-team' })
    expect(created.status).toBe(200)
    const team = created.body.team as { id: string; directory: string }
    expect(team.directory).toBe('/tmp/api-team')
    expect((await host.api('GET', `teams/${team.id}`)).body).toMatchObject({ task: 'API task', directory: '/tmp/api-team' })
    expect((await host.api('GET', 'teams/missing')).status).toBe(404)
    const settings = host.runtime.store.settings()
    host.runtime.store.saveSettings({ ...settings, paused: true })
    expect((await host.api('POST', 'teams', { task: 'blocked' })).status).toBe(400)
    host.runtime.store.saveSettings({ ...settings, paused: false })
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
