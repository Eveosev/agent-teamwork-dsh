/** Team list with a start form and team detail with the six role cards, member sessions, outputs and final summary. */
import { useState, type FormEvent } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { ApiError, usePoll } from './api.ts'
import { Button, Dot, Icon, InfoTip, Input, Tag, type DotState, type TagTone } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { valueLabel, type T } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadState, MarkdownLite, PageHead, Section, SessionButton, When } from './widgets.tsx'

type Team = ApiResponse<'GET teams/:id'>
type TeamSummary = ApiResponse<'GET teams'>['items'][number]
type TeamMember = Team['members'][number]
type TeamState = Team['state']
type MemberState = TeamMember['state']
type TeamRole = TeamMember['role']

const TEAM_ROLES = ['lead', 'researcher', 'developer', 'tester', 'reviewer', 'ops'] as const satisfies readonly TeamRole[]
const OUTPUT_PREVIEW = 1200

const stateDot = (state: MemberState): DotState => state === 'running' ? 'ongoing' : state === 'done' ? 'done'
  : state === 'failed' ? 'error' : 'idle'
const memberTone = (state: MemberState): TagTone => state === 'running' ? 'info' : state === 'done' ? 'success'
  : state === 'failed' ? 'danger' : state === 'stopped' ? 'neutral' : 'outline'
const teamTone = (state: TeamState): TagTone => state === 'running' ? 'info' : state === 'done' ? 'success'
  : state === 'failed' ? 'danger' : 'neutral'
const roleLabel = (t: T, role: TeamRole): string => valueLabel(t, 'teamRole', role)
const memberLabel = (t: T, state: MemberState): string => valueLabel(t, 'teamMemberState', state)
const teamStateLabel = (t: T, state: TeamState): string => valueLabel(t, 'teamState', state)
const doneCount = (members: readonly { state: MemberState }[]): number => members.filter(member => member.state === 'done').length

/** Format a start/end span with localized units; a missing end means it is still running. */
function durationText(t: T, from: string, to: string | undefined): string {
  const start = new Date(from).getTime()
  const end = to ? new Date(to).getTime() : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return ''
  const total = Math.max(0, Math.round((end - start) / 1000))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor(total % 86_400 / 3600)
  const minutes = Math.floor(total % 3600 / 60)
  const day = t('teamDays', { count: days }), hour = t('teamHours', { count: hours }),
    minute = t('teamMinutes', { count: minutes })
  if (days) return hours ? `${day} ${hour}` : day
  if (hours) return minutes ? `${hour} ${minute}` : hour
  if (minutes) return minute
  return t('teamSeconds', { count: total })
}

function MemberOutput({ text }: { text: string }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const long = text.length > OUTPUT_PREVIEW
  return <>
    <pre className="dt-pre">{long && !open ? `${text.slice(0, OUTPUT_PREVIEW)}…` : text}</pre>
    {long && <button type="button" className="dt-textlink dt-more" aria-expanded={open}
      onClick={() => setOpen(!open)}>{open ? t('collapse') : t('expand')}</button>}
  </>
}

function MemberCard({ team, role }: { team: Team; role: TeamRole }) {
  const { t } = usePanel()
  const member = team.members.find(item => item.role === role)
  const state = member?.state ?? 'idle'
  const label = memberLabel(t, state)
  const end = member?.ended_at ?? (state === 'running' ? undefined : team.updated_at)
  const elapsed = member?.started_at ? durationText(t, member.started_at, end) : t('empty')
  return <div className="dt-card" data-state={state}>
    <div className="dt-card-head">
      <Dot state={stateDot(state)} label={label} />
      <div className="dt-row-main">
        <div className="dt-row-label">{roleLabel(t, role)}</div>
        <div className="dt-row-meta"><span>{t('teamProfile')}{t('labelSeparator')}<span
          className="dt-mono">{member?.profile ?? t('teamDefaultProfile')}</span></span></div>
      </div>
      <Tag tone={memberTone(state)}>{label}</Tag>
    </div>
    <div className="dt-row-meta"><LabelValue label={t('teamElapsed')} value={elapsed} /></div>
    {member?.session_id && <div className="dt-actions">
      <span className="dt-mono">{member.session_id}</span>
      <SessionButton variant="outline" sessionId={member.session_id} />
    </div>}
    {member?.error && <p className="dt-banner dt-danger dt-mono">
      <span className="dt-banner-label">{t('teamError')}{t('labelSeparator')}</span>{member.error}
    </p>}
    {member?.output && <div className="dt-part">
      <div className="dt-field-head">{t('teamOutput')}</div>
      <MemberOutput text={member.output} />
    </div>}
  </div>
}

function TeamLine({ team, reload }: { team: TeamSummary; reload: () => Promise<void> }) {
  const { t, call, navigate } = usePanel()
  const running = team.state === 'running'
  return <li className="dt-row dt-link">
    <div className="dt-row-main">
      <div className="dt-row-title"><button type="button" className="dt-open"
        onClick={() => navigate({ page: 'team', id: team.id })}>{team.title}</button></div>
      <div className="dt-row-meta">
        <Tag tone={teamTone(team.state)}>{teamStateLabel(t, team.state)}</Tag>
        <LabelValue label={t('teamProgress')} value={`${doneCount(team.members)}/${TEAM_ROLES.length}`} />
        <LabelValue label={t('teamCreated')} value={<When at={team.created_at} />} />
        <span className="dt-team-dots">{TEAM_ROLES.map(role => {
          const state = team.members.find(member => member.role === role)?.state ?? 'idle'
          return <Dot key={role} state={stateDot(state)} label={`${roleLabel(t, role)} · ${memberLabel(t, state)}`} />
        })}</span>
      </div>
      {team.summary && <div className="dt-row-quote">{team.summary}</div>}
    </div>
    {running && <div className="dt-row-actions">
      <ConfirmButton variant="outline" icon="stop" label={t('stop')} title={t('teamStopTitle')}
        message={t('teamStopConfirm', { title: team.title })}
        onConfirm={async () => { await call('POST teams/:id/stop', { id: team.id }); await reload() }} />
    </div>}
  </li>
}

/** Team tab root: the active team count, a compact start form, and every team newest first. */
export function TeamStatus() {
  const { t, call, navigate } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET teams'), [])
  const [task, setTask] = useState('')
  const [title, setTitle] = useState('')
  const [directory, setDirectory] = useState('')
  const create = useAction(async () => {
    const request = { task: task.trim(), ...(title.trim() ? { title: title.trim() } : {}), ...(directory.trim() ? { directory: directory.trim() } : {}) }
    const { team } = await call('POST teams', { body: request })
    setTask(''); setTitle(''); setDirectory('')
    await reload()
    navigate({ page: 'team', id: team.id })
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!task.trim() || create.busy) return
    void create.run()
  }
  return <>
    <div className="dt-status-head">
      <h2 className="dt-status-title">{t('teamTitle')}<InfoTip text={t('teamIntro')} /></h2>
      {data && <span className="dt-status-text">{t('teamActiveCount', { count: data.active })}</span>}
    </div>
    <form className="dt-form dt-block" onSubmit={submit}>
      <h2 className="dt-block-title">{t('teamNew')}</h2>
      <div className="dt-field">
        <label htmlFor="dt-team-task">{t('teamTask')}</label>
        <textarea id="dt-team-task" className="dt-textarea" rows={3} required value={task}
          placeholder={t('teamTaskPlaceholder')} onChange={event => setTask(event.target.value)} />
      </div>
      <div className="dt-field">
        <label htmlFor="dt-team-title">{t('teamTitleLabel')}</label>
        <Input id="dt-team-title" value={title} placeholder={t('teamTitlePlaceholder')}
          onChange={event => setTitle(event.target.value)} />
      </div>
      <div className="dt-field">
        <label htmlFor="dt-team-directory">{t('teamDirectoryRun')}</label>
        <Input id="dt-team-directory" className="dt-mono" value={directory} placeholder={t('teamDirectoryRunPlaceholder')}
          onChange={event => setDirectory(event.target.value)} />
        <div className="dt-hint">{t('teamDirectoryRunHint')}</div>
      </div>
      <div className="dt-actions">
        <Button variant="primary" type="submit" icon={<Icon name="plus" size={14} />}
          disabled={create.busy || !task.trim()}>{t('teamStart')}</Button>
      </div>
    </form>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(team => <TeamLine key={team.id} team={team}
      reload={reload} />)}</ul> : <div className="dt-section">
      <Hint>{t('teamEmpty')}</Hint>
      <div className="dt-actions">{TEAM_ROLES.map(role => <Tag key={role} tone="neutral">{roleLabel(t, role)}</Tag>)}</div>
    </div>)}
  </>
}

/** Team detail: state and duration, the task, six role cards, and the lead's final summary. */
export function TeamPage({ id }: { id: string }) {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET teams/:id', { id }), [id])
  if (!data) return <>
    <PageHead title={t('tab.team')} />
    {error instanceof ApiError && error.missing ? <Hint>{t('teamNotFound')}</Hint> : <LoadState error={error} loading />}
  </>
  const running = data.state === 'running'
  const end = running ? undefined : data.updated_at
  return <>
    <PageHead title={data.title} />
    {error && <LoadState error={error} loading={false} />}
    <div className="dt-row-meta dt-status-line">
      <Tag tone={teamTone(data.state)}>{teamStateLabel(t, data.state)}</Tag>
      <LabelValue label={t('teamProgress')} value={`${doneCount(data.members)}/${TEAM_ROLES.length}`} />
      <LabelValue label={t('teamCreated')} value={<When at={data.created_at} />} />
      <LabelValue label={running ? t('teamRunningFor') : t('teamDuration')}
        value={durationText(t, data.created_at, end)} />
      <LabelValue label={t('teamDirectory')} value={<span className="dt-mono">{data.directory}</span>} />
      {running && <ConfirmButton variant="outline" icon="stop" label={t('stop')} title={t('teamStopTitle')}
        message={t('teamStopConfirm', { title: data.title })}
        onConfirm={async () => { await call('POST teams/:id/stop', { id }); await reload() }} />}
    </div>
    {data.error && <p className="dt-banner dt-danger dt-mono">
      <span className="dt-banner-label">{t('teamError')}{t('labelSeparator')}</span>{data.error}
    </p>}
    <Section title={t('teamTask')}><div className="dt-event-text">{data.task}</div></Section>
    <Section title={t('teamMembers')} count={TEAM_ROLES.length}>
      <div className="dt-grid3">{TEAM_ROLES.map(role => <MemberCard key={role} team={data} role={role} />)}</div>
    </Section>
    {data.summary && <Section title={t('teamSummary')}><MarkdownLite text={data.summary} /></Section>}
  </>
}
