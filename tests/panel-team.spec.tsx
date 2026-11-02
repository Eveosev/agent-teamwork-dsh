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
  await click(all('.dt-open').find(button => button.textContent === '修复登录页回归')!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复登录页回归')
  expect(all('.dt-page-head button')[0]?.textContent).toBe(zh['tab.team'])
  expect(all('.dt-grid3 .dt-card').length).toBe(6)
  expect(all('.dt-card .dt-row-label').map(label => label.textContent)).toEqual(['团队负责人', '调研员', '开发者', '测试员', '评审员', '运维'])
  expect(all('.dt-card .dt-tag').map(tag => tag.textContent)).toEqual(['完成', '执行中', '完成', '失败', '待命', '待命'])
  expect(text()).toContain('配置：researcher')
  expect(text()).toContain('配置：默认')
  expect(text()).toContain('Tests failed: 1 failure')
  // A long lead output is truncated behind Show all, and the session opens in the host panel.
  expect(text()).not.toContain('END-OF-LEAD-OUTPUT')
  await click(find(zh.openSession))
  expect(server.opened).toContain('team-lead')
  await click(zh.expand)
  expect(text()).toContain('END-OF-LEAD-OUTPUT')
  await click(zh.collapse)
  expect(text()).not.toContain('END-OF-LEAD-OUTPUT')
})

it('starts a team from the form and opens the new team', async () => {
  await mount()
  await click(tab(zh['tab.team']))
  await type(field<HTMLTextAreaElement>(zh.teamTask), 'Ship the release')
  await type(field<HTMLInputElement>(zh.teamTitleLabel), '发布修复')
  await click(zh.teamStart)
  expect(server.requests.find(request => request.path === 'teams' && request.method === 'POST'))
    .toMatchObject({ body: { task: 'Ship the release', title: '发布修复' } })
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('发布修复')
  expect(all('.dt-grid3 .dt-card').length).toBe(6)
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
  expect(all('button').some(button => button.textContent === zh.stop)).toBe(false)
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
