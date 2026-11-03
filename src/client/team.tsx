/** Team list with a start form and team detail with the six role cards, member sessions, outputs and final summary. */
import { useState, type FormEvent } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { ApiError, usePoll } from './api.ts'
import { Button, Dot, Icon, InfoTip, Input, Modal, Tag, type DotState, type TagTone } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { valueLabel, type T } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadState, MarkdownLite, PageHead, Section, SessionButton, When } from './widgets.tsx'

type Team = ApiResponse<'GET teams/:id'>
type TeamSummary = ApiResponse<'GET teams'>['items'][number]
type TeamMember = Team['members'][number]
type TeamState = Team['state']
type MemberState = TeamMember['state']
type TeamRole = TeamMember['role']
type TeamOutcome = NonNullable<Team['outcome']>
type TeamUsage = NonNullable<Team['usage']>

const TEAM_ROLES = ['lead', 'researcher', 'developer', 'tester', 'reviewer', 'ops'] as const satisfies readonly TeamRole[]

const stateDot = (state: MemberState): DotState => state === 'running' ? 'ongoing' : state === 'done' ? 'done'
  : state === 'failed' ? 'error' : 'idle'
const memberTone = (state: MemberState): TagTone => state === 'running' ? 'info' : state === 'done' ? 'success'
  : state === 'failed' ? 'danger' : state === 'stopped' ? 'neutral' : 'outline'
const teamTone = (state: TeamState): TagTone => state === 'running' ? 'info' : state === 'done' ? 'success'
  : state === 'failed' ? 'danger' : 'neutral'
const roleLabel = (t: T, role: TeamRole): string => valueLabel(t, 'teamRole', role)
const memberLabel = (t: T, state: MemberState): string => valueLabel(t, 'teamMemberState', state)
const teamStateLabel = (t: T, state: TeamState): string => valueLabel(t, 'teamState', state)
const outcomeLabel = (t: T, outcome: TeamOutcome): string => outcome === 'achieved' ? t('teamOutcome.achieved')
  : outcome === 'not_achieved' ? t('teamOutcome.not_achieved') : t('teamOutcome.unverified')
const outcomeTone = (outcome: TeamOutcome): TagTone => outcome === 'achieved' ? 'success'
  : outcome === 'not_achieved' ? 'danger' : 'warning'
/** Older records finished before outcome markers existed; without evidence they are unverified, never implicitly successful. */
const shownOutcome = (state: TeamState, outcome: TeamOutcome | undefined): TeamOutcome | undefined =>
  outcome ?? (state === 'done' ? 'unverified' : undefined)
function OutcomeTag({ state, outcome }: { state: TeamState; outcome?: TeamOutcome }) {
  const { t } = usePanel()
  const shown = shownOutcome(state, outcome)
  return shown ? <Tag tone={outcomeTone(shown)}>{outcomeLabel(t, shown)}</Tag> : null
}
const doneCount = (members: readonly { state: MemberState }[]): number => members.filter(member => member.state === 'done').length
const tokenCount = (value: number): string => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)

/** One role's or one team's input/output/cached token totals. */
function TokenUsageLine({ usage }: { usage: TeamUsage }) {
  const { t } = usePanel()
  return <span className="dt-token-usage" title={`${t('teamTokenInput')} ${usage.input}${t('listSeparator')}${t('teamTokenOutput')} ${usage.output}${t('listSeparator')}${t('teamTokenCached')} ${usage.cached}`}>
    <span className="dt-token-usage-label">{t('teamTokens')}</span>
    <span>{t('teamTokenInput')} <strong>{tokenCount(usage.input)}</strong></span>
    <span>{t('teamTokenOutput')} <strong>{tokenCount(usage.output)}</strong></span>
    <span>{t('teamTokenCached')} <strong>{tokenCount(usage.cached)}</strong></span>
  </span>
}

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

/** A collapsed reading card for long Markdown; the full text opens in a dialog. */
function ReadingCard({ text, title, action, kind }: {
  text: string; title: string; action: string; kind: 'summary' | 'output'
}) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const long = text.length > 600
  return <>
    <div className="dt-reading-card" data-kind={kind} role="button" tabIndex={0} aria-haspopup="dialog" aria-label={action}
      onClick={() => setOpen(true)}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        setOpen(true)
      }}>
      <div className={long ? 'dt-reading-preview dt-reading-preview-fade' : 'dt-reading-preview'}>
        <MarkdownLite text={text} links={false} />
      </div>
      <span className="dt-reading-more">{action}<Icon name="chevron-right" size={12} /></span>
    </div>
    <Modal open={open} onClose={() => setOpen(false)} title={title} closeLabel={t('close')}
      className="dt-reading-modal">
      <div className="dt-reading-body"><MarkdownLite text={text} /></div>
    </Modal>
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
      <span className="dt-tag-group">
        <Tag tone={memberTone(state)}>{label}</Tag>
        {member?.verdict && <Tag tone={member.verdict === 'pass' ? 'success' : 'danger'}>
          {member.verdict === 'pass' ? t('teamVerdict.pass') : t('teamVerdict.fail')}</Tag>}
      </span>
    </div>
    <div className="dt-row-meta"><LabelValue label={t('teamElapsed')} value={elapsed} />
      {member?.round && member.round > 1 && <LabelValue label={t('teamRounds')} value={member.round} />}
      {member?.usage && <TokenUsageLine usage={member.usage} />}
    </div>
    {member?.session_id && <div className="dt-actions">
      <span className="dt-mono">{member.session_id}</span>
      <SessionButton variant="outline" sessionId={member.session_id} />
    </div>}
    {member?.error && <p className="dt-banner dt-danger dt-mono">
      <span className="dt-banner-label">{t('teamError')}{t('labelSeparator')}</span>{member.error}
    </p>}
    {member?.output && <div className="dt-part">
      <div className="dt-field-head">{t('teamOutput')}</div>
      <ReadingCard kind="output" text={member.output} title={`${roleLabel(t, role)}${t('labelSeparator')}${t('teamOutput')}`}
        action={t('teamOutputRead')} />
    </div>}
  </div>
}

function TeamLine({ team, reload }: { team: TeamSummary; reload: () => Promise<void> }) {
  const { t, call, navigate } = usePanel()
  const running = team.state === 'running'
  return <li className={team.summary ? 'dt-row dt-link dt-row-reading' : 'dt-row dt-link'}>
    <div className="dt-row-main">
      <div className="dt-row-title"><button type="button" className="dt-open"
        onClick={() => navigate({ page: 'team', id: team.id })}>{team.title}</button></div>
      <div className="dt-row-meta">
        <Tag tone={teamTone(team.state)}>{teamStateLabel(t, team.state)}</Tag>
        <OutcomeTag state={team.state} outcome={team.outcome} />
        {team.continued_from && <Tag tone="info" title={`${t('teamContinuedFrom')}: ${team.continued_from_title ?? team.continued_from}`}>{t('teamContinued')}</Tag>}
        <LabelValue label={t('teamProgress')} value={`${doneCount(team.members)}/${TEAM_ROLES.length}`} />
        <LabelValue label={t('teamCreated')} value={<When at={team.created_at} />} />
        {team.rounds && <LabelValue label={t('teamRounds')} value={team.rounds} />}
        {team.usage && <TokenUsageLine usage={team.usage} />}
        <span className="dt-team-dots">{TEAM_ROLES.map(role => {
          const state = team.members.find(member => member.role === role)?.state ?? 'idle'
          return <Dot key={role} state={stateDot(state)} label={`${roleLabel(t, role)} · ${memberLabel(t, state)}`} />
        })}</span>
      </div>
      {team.summary && <TeamSummaryCard text={team.summary} />}
    </div>
    <div className="dt-row-actions">
      {running ? <ConfirmButton variant="outline" icon="stop" label={t('stop')} title={t('teamStopTitle')}
        message={t('teamStopConfirm', { title: team.title })}
        onConfirm={async () => { await call('POST teams/:id/stop', { id: team.id }); await reload() }} />
        : <ContinueTeamButton team={team} />}
    </div>
  </li>
}

/** Start a linked run from a finished team; the source record stays intact. */
function ContinueTeamButton({ team }: { team: { id: string; title: string } }) {
  const { t, call, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const start = useAction(async () => {
    const body = instruction.trim() ? { instruction: instruction.trim() } : {}
    const { team: started } = await call('POST teams/:id/continue', { id: team.id, body })
    setOpen(false); setInstruction('')
    navigate({ page: 'team', id: started.id })
  })
  const fieldId = `dt-team-continue-${team.id}`
  return <>
    <Button variant="outline" size="sm" icon={<Icon name="play" size={14} />} onClick={() => setOpen(true)}>{t('teamContinue')}</Button>
    <Modal open={open} onClose={() => setOpen(false)} title={t('teamContinueTitle')} closeLabel={t('close')}
      description={t('teamContinueHint')}
      footer={<>
        <Button variant="ghost" onClick={() => setOpen(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={start.busy} onClick={() => { void start.run() }}>{t('teamContinueStart')}</Button>
      </>}>
      <div className="dt-field">
        <label htmlFor={fieldId}>{t('teamContinuation')}</label>
        <textarea id={fieldId} className="dt-textarea" rows={4} value={instruction}
          placeholder={t('teamContinuePlaceholder')} onChange={event => setInstruction(event.target.value)} />
      </div>
    </Modal>
  </>
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

/** A collapsed, clickable reading card for the final summary; the full Markdown opens in a dialog. */
function TeamSummaryCard({ text }: { text: string }) {
  const { t } = usePanel()
  return <ReadingCard kind="summary" text={text} title={t('teamSummary')} action={t('teamSummaryRead')} />
}

/** Team detail: state and duration, the task, six role cards, and the lead's final summary. */
export function TeamPage({ id }: { id: string }) {
  const { t, call, navigate } = usePanel()
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
      <OutcomeTag state={data.state} outcome={data.outcome} />
      <LabelValue label={t('teamProgress')} value={`${doneCount(data.members)}/${TEAM_ROLES.length}`} />
      <LabelValue label={t('teamCreated')} value={<When at={data.created_at} />} />
      <LabelValue label={running ? t('teamRunningFor') : t('teamDuration')}
        value={durationText(t, data.created_at, end)} />
      {data.rounds && <LabelValue label={t('teamRounds')} value={data.rounds} />}
      {data.usage && <TokenUsageLine usage={data.usage} />}
      {data.continued_from && <LabelValue label={t('teamContinuedFrom')} value={
        <button type="button" className="dt-inline-button" onClick={() => navigate({ page: 'team', id: data.continued_from! })}>
          {data.continued_from_title ?? data.continued_from}</button>} />}
      <LabelValue label={t('teamDirectory')} value={<span className="dt-mono">{data.directory}</span>} />
      {running ? <ConfirmButton variant="outline" icon="stop" label={t('stop')} title={t('teamStopTitle')}
        message={t('teamStopConfirm', { title: data.title })}
        onConfirm={async () => { await call('POST teams/:id/stop', { id }); await reload() }} />
        : <ContinueTeamButton team={data} />}
    </div>
    {data.error && <p className="dt-banner dt-danger dt-mono">
      <span className="dt-banner-label">{t('teamError')}{t('labelSeparator')}</span>{data.error}
    </p>}
    <Section title={t('teamTask')}><div className="dt-event-text">{data.task}</div></Section>
    {data.continuation && <Section title={t('teamContinuation')}><div className="dt-event-text">{data.continuation}</div></Section>}
    <Section title={t('teamMembers')} count={TEAM_ROLES.length}>
      <div className="dt-grid3">{TEAM_ROLES.map(role => <MemberCard key={role} team={data} role={role} />)}</div>
    </Section>
    {data.summary && <Section title={t('teamSummary')} badge={<OutcomeTag state={data.state} outcome={data.outcome} />}>
      <TeamSummaryCard text={data.summary} />
    </Section>}
  </>
}
