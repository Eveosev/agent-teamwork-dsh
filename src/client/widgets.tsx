/** Context-aware shared UI widgets: page/section headers, timestamps, Markdown rendering, and confirmation actions. */
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { SetupProblem } from '../setup.ts'
import { Button, Icon, InfoTip, Modal, StateDot, type DotState, type IconName } from './controls.tsx'
import { inlines, linkify, markdownBlocks, type Inline } from './markdown.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute, type SettingsGroup } from './route.ts'
import { errorText, fullTime, readableMarkers, setupText, when } from './text.ts'

const external = { target: '_blank', rel: 'noopener noreferrer' } as const

export function When({ at }: { at: string | undefined }) {
  const { t } = usePanel()
  return <time dateTime={at} title={fullTime(at, t('lang'))}>{when(at, t('lang'))}</time>
}
export function SetupMessage({ problem, lead }: { problem: Pick<SetupProblem, 'code' | 'values'>; lead?: boolean }) {
  const { t } = usePanel()
  const text = setupText(t, problem)
  return <>
    {lead ? t('setupProblem', { detail: text }) : text}
    {problem.values.output && <span className="dt-detail dt-mono dt-clamp">{problem.values.output}</span>}
  </>
}
export function Section({ title, count, children, action, hint, badge, icon }: {
  title: string; count?: number | string; children: ReactNode; action?: ReactNode; hint?: string; badge?: ReactNode; icon?: IconName
}) {
  return <section className="dt-section">
    <h2 className="dt-section-title">
      {icon && <span className="dt-section-icon"><Icon name={icon} size={14} /></span>}<span className="dt-section-name">{title}</span>
      {count !== undefined && <span className="dt-count">{count}</span>}{hint && <InfoTip text={hint} />}{badge}
      {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
    </h2>
    {children}
  </section>
}
export function Hint({ children }: { children: ReactNode }) { return <p className="dt-hint">{children}</p> }
export function LabelValue({ label, value }: { label: string; value: ReactNode }) {
  return <span className="dt-lv"><span className="dt-lv-label">{label}</span> <span className="dt-lv-value">{value}</span></span>
}
export function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="dt-kv">{rows.map(([key, value], index) => <div key={index}
    style={{ display: 'contents' }}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
}

const dataUri = (file: Pick<ApiResponse<'GET teams/:id/file'>, 'mime' | 'data'>): string => `data:${file.mime};base64,${file.data}`
const decodeText = (data: string): string => {
  try { return new TextDecoder().decode(Uint8Array.from(atob(data), char => char.charCodeAt(0))) } catch { return '' }
}

/** A local image in a Team output, fetched through the authenticated Team file route and shown as a data URL. */
function TeamImage({ src, alt, teamId }: { src: string; alt: string; teamId?: string }) {
  const { t, call } = usePanel()
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  const remote = /^https?:\/\//.test(src)
  useEffect(() => {
    if (remote || !teamId) return
    let live = true
    setFailed(false); setUrl(undefined)
    void call('GET teams/:id/file', { id: teamId, query: { path: src } }).then(file => { if (live) setUrl(dataUri(file)) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [call, remote, src, teamId])
  if (remote) return <span className="dt-md-image"><img src={src} alt={alt} loading="lazy" /></span>
  if (!teamId || failed) return <span className="dt-md-image-fallback" title={src}>{alt || t('imageMarker')}</span>
  if (!url) return <span className="dt-md-image-fallback">{t('imageMarker')}</span>
  return <span className="dt-md-image">
    <a href={url} target="_blank" rel="noopener noreferrer" title={alt || src}><img src={url} alt={alt} loading="lazy" /></a>
    {alt && <span className="dt-md-image-caption">{alt}</span>}
  </span>
}

/** Opens a text or image file from the Team directory in a dialog; paths outside it are refused by the host. */
function LocalFileLink({ label, path, teamId, enabled }: { label: string; path: string; teamId?: string; enabled: boolean }) {
  const { t, call, notify } = usePanel()
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<ApiResponse<'GET teams/:id/file'>>()
  const [busy, setBusy] = useState(false)
  if (!enabled) return <span className="dt-md-local" title={path}>{label}</span>
  const openFile = async () => {
    if (!teamId) { notify(t('fileUnavailable')); return }
    setBusy(true)
    try {
      const target = path.replace(/^file:\/\//, '').split('#')[0]!
      setFile(await call('GET teams/:id/file', { id: teamId, query: { path: target } }))
      setOpen(true)
    } catch (failure) { notify(errorText(failure)) }
    finally { setBusy(false) }
  }
  return <>
    <button type="button" className="dt-md-local dt-md-local-button" title={path} disabled={busy}
      onClick={() => { void openFile() }}>{label}</button>
    {file && <Modal open={open} onClose={() => setOpen(false)} title={file.name} closeLabel={t('close')}
      className="dt-reading-modal">
      {file.mime.startsWith('image/') ? <img className="dt-file-image" src={dataUri(file)} alt={file.name} />
        : <pre className="dt-file-text">{decodeText(file.data)}</pre>}
    </Modal>}
  </>
}
function Inlines({ parts, links = true, teamId }: { parts: Inline[]; links?: boolean; teamId?: string }) {
  return <>{parts.map((part, index) => part.kind === 'bold' ? <strong key={index}>{part.text}</strong>
    : part.kind === 'code' ? <code key={index} className="dt-code">{part.text}</code>
    : part.kind === 'image' ? <TeamImage key={index} src={part.src} alt={part.alt} teamId={teamId} />
    : part.kind === 'link' && links ? <a key={index} className="dt-inline-link" href={part.url} title={part.url} {...external}>{part.text}</a>
    : part.kind === 'link' ? <span key={index} className="dt-inline-link">{part.text}</span>
    : part.kind === 'local' ? <LocalFileLink key={index} label={part.text} path={part.path} teamId={teamId} enabled={links} />
    : <Fragment key={index}>{part.text}</Fragment>)}</>
}
/** Renders a safe Markdown subset (headings, lists, paragraphs, tables, code blocks, rules, bold, inline code, links, and team-local images) without raw HTML. */
export function MarkdownLite({ text, links = true, teamId }: { text: string; links?: boolean; teamId?: string }) {
  const { t } = usePanel()
  return <div className="dt-md">{markdownBlocks(readableMarkers(t, text, true)).map((block, index) => {
    if (block.kind === 'rule') return <hr key={index} className="dt-md-rule" />
    if (block.kind === 'code') return <pre key={index} className="dt-md-code"><code>{block.text}</code></pre>
    if (block.kind === 'image') return <p key={index}><TeamImage src={block.src} alt={block.alt} teamId={teamId} /></p>
    if (block.kind === 'table') return <div key={index} className="dt-md-table-wrap"><table className="dt-md-table">
      <thead><tr>{block.headers.map((header, at) => <th key={at} style={{ textAlign: block.align[at] }}><Inlines
        parts={inlines(header)} links={links} teamId={teamId} /></th>)}</tr></thead>
      <tbody>{block.rows.map((row, at) => <tr key={at}>{row.map((cell, column) => <td key={column}
        style={{ textAlign: block.align[column] }}><Inlines parts={inlines(cell)} links={links} teamId={teamId} /></td>)}</tr>)}</tbody>
    </table></div>
    if (block.kind !== 'list') return <p key={index} className={block.kind === 'heading' ? 'dt-md-heading' : undefined}><Inlines
      parts={inlines(block.text)} links={links} teamId={teamId} /></p>
    const items = block.items.map((item, at) => <li key={at}><Inlines parts={inlines(item)} links={links} teamId={teamId} /></li>)
    return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
  })}</div>
}
function MoreToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = usePanel()
  return <button type="button" className="dt-textlink dt-more" aria-expanded={open} onClick={onToggle}>{open ? t('collapse')
    : t('expand')}</button>
}
export function ClampText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 480 || text.split('\n').length > 8
  return <>
    <div className={long && !open ? 'dt-event-text dt-clamp-8' : 'dt-event-text'}><Inlines parts={linkify(text)} /></div>
    {long && <MoreToggle open={open} onToggle={() => setOpen(!open)} />}
  </>
}

export function ConfirmButton({ label, title, message, onConfirm, variant = 'ghost', icon }: {
  label: string; title: string; message: string; onConfirm: () => Promise<unknown>; variant?: 'ghost' | 'outline'; icon?: IconName
}) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const confirm = useAction(onConfirm)
  return <>
    <Button variant={variant} size="sm" icon={icon && <Icon name={icon} size={14} />} onClick={() => setOpen(true)}>{label}</Button>
    <Modal open={open} onClose={() => setOpen(false)} title={title} closeLabel={t('close')} description={message}
      footer={<>
        <Button variant="ghost" onClick={() => setOpen(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={confirm.busy}
          onClick={() => { void confirm.run().then(done => { if (done) setOpen(false) }) }}>{t('confirm')}</Button>
      </>} />
  </>
}
export function SessionButton({ sessionId, label,
  variant = 'ghost' }: { sessionId: string; label?: string; variant?: 'ghost' | 'outline' }) {
  const { t, openSession, notify } = usePanel()
  return <Button variant={variant} size="sm" icon={<Icon name="session" size={14} />}
    onClick={() => { openSession(sessionId).catch(error => notify(errorText(error))) }}>{label ?? t('openSession')}</Button>
}
export function ExternalLink({ href, children, icon = 'external' }: { href: string; children: ReactNode; icon?: IconName }) {
  return <a className="dt-inline-link dt-icon-link" href={href} {...external}><Icon name={icon} size={13} />{children}</a>
}
export function ActionLink({ href, children, icon = 'external' }: { href: string; children: ReactNode; icon?: IconName }) {
  return <a className="dt-btn dt-btn-outline dt-btn-sm" href={href} {...external}><span className="dt-btn-icon"><Icon name={icon}
    size={14} /></span>{children}</a>
}
export function StageMark({ state, icon, label }: { state: DotState; icon: IconName; label: string }) {
  return <span className="dt-stage" data-state={state}>{state === 'ongoing' ? <StateDot state="ongoing" /> : <Icon name={icon}
    size={14} />}{label}</span>
}
export function LoadState({ error, loading }: { error?: Error | undefined; loading: boolean }) {
  const { t } = usePanel()
  if (error) return <p className="dt-error" role="alert">{error.message}</p>
  return loading ? <Hint>{t('loading')}</Hint> : null
}
export function LoadMore({ onMore }: { onMore: () => void }) {
  const { t } = usePanel()
  return <Button variant="outline" size="sm" icon={<Icon name="chevron-down" size={14} />} onClick={onMore}>{t('loadMore')}</Button>
}

export function StatusHead({ hint, settings }: { hint: string; settings?: SettingsGroup }) {
  const { t, navigate } = usePanel()
  return <div className="dt-status-head">
    <h2 className="dt-status-title">{t('statusTitle')}<InfoTip text={hint} /></h2>
    {settings && <Button variant="ghost" size="sm" icon={<Icon name="settings" />}
      onClick={() => navigate(settingsRoute(settings))}>{t('tab.settings')}</Button>}
  </div>
}
export function PageHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  const { back, backLabel } = usePanel()
  return <div className="dt-page-head">
    <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" />} onClick={back}>{backLabel}</Button>
    <div className="dt-page-title"><h2>{title}</h2>{children && <span className="dt-actions">{children}</span>}</div>
  </div>
}
/** Trigger a host setup re-check and restart, prompting for confirmation when running Assignments would be interrupted. */
export function CheckSetupButton() {
  const { t, call, notify, restart } = usePanel()
  const { running } = usePanelData()
  const check = async () => { await call('POST setup/check'); notify(t('setupChecking')); restart() }
  const action = useAction(check)
  if (running > 0) {
    const message = t('setupCheckInterrupts', { count: running })
    return <ConfirmButton variant="outline" icon="refresh" label={t('setupCheck')} title={t('setupCheck')} message={message}
      onConfirm={check} />
  }
  const icon = <Icon name="refresh" size={14} />
  return <Button variant="outline" size="sm" icon={icon} disabled={action.busy}
    onClick={() => { void action.run() }}>{t('setupCheck')}</Button>
}
