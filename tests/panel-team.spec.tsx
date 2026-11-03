// @vitest-environment jsdom
// The Team tab: the team list, the start form, a team detail, and stopping a running team.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('lists teams with their state, progress and member dots, and opens the six role cards', async () => {
  await mount()
  await click(tab(zh['tab.team']))
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh.teamTitle)
  expect(text()).toContain('1 个运行中')
  expect(all('.dt-list .dt-row-title').map(title => title.textContent)).toEqual(['修复登录页回归', '发布检查'])
  expect(all('.dt-team-dots').map(strip => strip.querySelectorAll('.dt-dot').length)).toEqual([6, 6])
  expect(text()).toContain(zh['teamOutcome.achieved'])
  expect(text()).toContain(zh.teamTokens)
  expect(text()).toContain(zh.teamTokenCached)
  await click(all('.dt-open').find(button => button.textContent === '修复登录页回归')!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复登录页回归')
  expect(all('.dt-page-head button')[0]?.textContent).toBe(zh['tab.team'])
  expect(all('.dt-grid3 .dt-card').length).toBe(6)
  expect(all('.dt-card .dt-row-label').map(label => label.textContent)).toEqual(['团队负责人', '调研员', '开发者', '测试员', '评审员', '运维'])
  expect(all('.dt-card .dt-tag').map(tag => tag.textContent)).toEqual(['完成', '执行中', '完成', '失败', '待命', '待命'])
  expect(text()).toContain('配置：researcher')
  expect(text()).toContain('配置：默认')
  expect(text()).toContain('Tests failed: 1 failure')
  // Member output is rendered as a collapsed reading card with the same dialog as the summary.
  expect(all('.dt-card .dt-md-table th').map(cell => cell.textContent)).toEqual(['Step', 'State'])
  const output = document.querySelector<HTMLElement>('.dt-card .dt-reading-card[data-kind="output"]')!
  expect(output.textContent).toContain(zh.teamOutputRead)
  expect(output.querySelector('.dt-reading-preview')).not.toBeNull()
  await click(output)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('END-OF-LEAD-OUTPUT')
  await click(find(zh.close))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await click(find(zh.openSession))
  expect(server.opened).toContain('team-lead')
})

it('filters teams by done, to verify, running and all', async () => {
  server.teams.items[1]!.outcome = 'unverified'
  await mount()
  await click(tab(zh['tab.team']))
  expect(all('.dt-filters button').map(button => button.textContent)).toEqual([zh['teamFilter.verify'],
    zh['teamFilter.running'], zh['teamFilter.done'], zh['teamFilter.all']])
  expect(all('.dt-list .dt-row-title').map(title => title.textContent)).toEqual(['修复登录页回归', '发布检查'])
  await click(find(zh['teamFilter.running']))
  expect(all('.dt-list .dt-row-title').map(title => title.textContent)).toEqual(['修复登录页回归'])
  await click(find(zh['teamFilter.verify']))
  expect(all('.dt-list .dt-row-title').map(title => title.textContent)).toEqual(['发布检查'])
  await click(find(zh['teamFilter.done']))
  expect(all('.dt-list .dt-row-title')).toHaveLength(0)
  expect(text()).toContain(zh.none)
  await click(find(zh['teamFilter.all']))
  expect(all('.dt-list .dt-row-title').map(title => title.textContent)).toEqual(['修复登录页回归', '发布检查'])
})

it('starts a team from the form and opens the new team', async () => {
  await mount()
  await click(tab(zh['tab.team']))
  await type(field<HTMLTextAreaElement>(zh.teamTask), 'Ship the release')
  await type(field<HTMLInputElement>(zh.teamTitleLabel), '发布修复')
  await type(field<HTMLInputElement>(zh.teamDirectoryRun), '/tmp/repo')
  await click(zh.teamStart)
  expect(server.requests.find(request => request.path === 'teams' && request.method === 'POST'))
    .toMatchObject({ body: { task: 'Ship the release', title: '发布修复', directory: '/tmp/repo' } })
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('发布修复')
  expect(all('.dt-grid3 .dt-card').length).toBe(6)
})

it('continues a finished team from its page with an optional instruction', async () => {
  at({ page: 'team', id: 'team-2' })
  await mount()
  await click(zh.teamContinue)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(zh.teamContinueTitle)
  await type(field<HTMLTextAreaElement>(zh.teamContinuation), 'Fix the remaining check')
  await click(zh.teamContinueStart)
  expect(server.requests.find(request => request.path === 'teams/team-2/continue' && request.method === 'POST'))
    .toMatchObject({ body: { instruction: 'Fix the remaining check' } })
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('发布检查')
  expect(server.teams.items).toHaveLength(2)
  expect(server.teams.items.find(team => team.id === 'team-2')).toMatchObject({ state: 'running', continuations: 1 })
  expect(text()).toContain(zh.teamContinuation)
  expect(text()).toContain(zh.teamPreviousAttempt)
  expect(text()).toContain('Fix the remaining check')
  expect(text()).toContain(zh.teamContinuationTargets)
  expect(text()).toContain(zh['teamRole.lead'])
  expect(all('.dt-grid3 .dt-card').length).toBe(6)
})

it('falls back to a plain team when the host predates the continuation route', async () => {
  server.legacyContinue = true
  at({ page: 'team', id: 'team-2' })
  await mount()
  await click(zh.teamContinue)
  await type(field<HTMLTextAreaElement>(zh.teamContinuation), 'Fix the remaining check')
  await click(zh.teamContinueStart)
  const created = server.requests.filter(request => request.path === 'teams' && request.method === 'POST').at(-1)
  expect(created?.body).toMatchObject({ title: `发布检查 · ${zh.teamContinued}`, directory: '/tmp/team' })
  expect((created?.body as { task: string }).task).toContain('Continuation of team team-2')
  expect((created?.body as { task: string }).task).toContain('Fix the remaining check')
  expect((created?.body as { task: string }).task).toContain('all six roles')
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe(`发布检查 · ${zh.teamContinued}`)
  expect(text()).toContain('Continuation of team team-2')
})

it('stops a running team from the list after confirmation', async () => {
  await mount()
  await click(tab(zh['tab.team']))
  await click(find(zh.stop))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('停止团队“修复登录页回归”')
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'teams/team-1/stop' && request.method === 'POST')).toBe(true)
  expect(text()).toContain(zh['teamState.stopped'])
  expect(all('button').some(button => button.textContent === zh.stop)).toBe(false)
})

it('stops a running team from its page after confirmation', async () => {
  at({ page: 'team', id: 'team-1' })
  await mount()
  await click(zh.stop)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('停止团队')
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'teams/team-1/stop' && request.method === 'POST')).toBe(true)
  expect(text()).toContain(zh['teamState.stopped'])
})

it('shows the final summary of a finished team without a stop action', async () => {
  at({ page: 'team', id: 'team-2' })
  await mount()
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('发布检查')
  expect(text()).toContain(zh.teamSummary)
  expect(text()).toContain('No action')
  expect(document.querySelector('.dt-md-table th')?.textContent).toBe('Check')
  expect(all('.dt-md-table td').map(cell => cell.textContent)).toEqual(['tests', '✅', 'build', '✅'])
  expect(all('button').some(button => button.textContent === zh.stop)).toBe(false)
  expect(text()).toContain(zh['teamOutcome.achieved'])
  expect(text()).toContain(zh.teamTokens)
  expect(text()).toContain(zh.teamTokenInput)
  expect(text()).toContain(zh.teamTokenOutput)
  expect(text()).toContain(zh.teamTokenCached)
})

it('shows a finished team with no recorded outcome as unverified, never implicitly successful', async () => {
  delete server.teams.details['team-2']!.outcome
  delete server.teams.items.find(team => team.id === 'team-2')!.outcome
  await mount()
  await click(tab(zh['tab.team']))
  expect(text()).toContain(zh['teamOutcome.unverified'])
})

it('marks a finished team that did not meet its goal instead of showing only Done', async () => {
  const team = server.teams.details['team-2']!
  team.outcome = 'not_achieved'
  team.summary = 'The build passed, but the acceptance criteria were not met.'
  at({ page: 'team', id: 'team-2' })
  await mount()
  const badge = document.querySelector<HTMLElement>('.dt-status-line .dt-tag[data-tone="danger"]')
  expect(badge?.textContent).toBe(zh['teamOutcome.not_achieved'])
})

it('opens the collapsed final summary in a Markdown reading dialog', async () => {
  at({ page: 'team', id: 'team-2' })
  await mount()
  const card = document.querySelector<HTMLElement>('.dt-reading-card[data-kind="summary"]')!
  expect(card.getAttribute('aria-haspopup')).toBe('dialog')
  expect(card.textContent).toContain(zh.teamSummaryRead)
  expect(document.querySelector('.dt-reading-preview .dt-md-table')).not.toBeNull()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await click(card)
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog.getAttribute('aria-label')).toBe(zh.teamSummary)
  expect(dialog.querySelector('.dt-md-table')).not.toBeNull()
  await click(find(zh.close))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('opens the summary from the teams list without leaving the list', async () => {
  await mount()
  await click(tab(zh['tab.team']))
  const card = document.querySelector<HTMLElement>('.dt-list .dt-reading-card[data-kind="summary"]')!
  expect(card).not.toBeNull()
  await click(card)
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(zh.teamSummary)
  expect(document.querySelector('.dt-status-title')?.textContent).toContain(zh.teamTitle)
  await click(find(zh.close))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('explains /team and the six roles when there are no teams', async () => {
  server.teams = { items: [], details: {} }
  await mount()
  await click(tab(zh['tab.team']))
  expect(text()).toContain('/team <task>')
  expect(all('.dt-tag').map(tag => tag.textContent)).toEqual(['团队负责人', '调研员', '开发者', '测试员', '评审员', '运维'])
})

it('reports a missing team instead of rendering an empty page', async () => {
  at({ page: 'team', id: 'missing' })
  await mount()
  expect(text()).toContain(zh.teamNotFound)
})
