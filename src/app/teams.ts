/** Six-role Agent Team runtime: /team creates a team, runs its roles as managed subagents, and records evidence for the panel. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { key } from '../core/ids.ts'
import type { Settings } from '../policy.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

export const TEAM_ROLES = ['lead', 'researcher', 'developer', 'tester', 'reviewer', 'ops'] as const
export type TeamRole = typeof TEAM_ROLES[number]
export type TeamState = 'running' | 'done' | 'failed' | 'stopped'
export type MemberState = 'idle' | 'running' | 'done' | 'failed' | 'stopped'
/** Whether the team's acceptance criteria were met, independently of whether execution finished. */
export type TeamOutcome = 'achieved' | 'not_achieved' | 'unverified'
export type MemberVerdict = 'pass' | 'fail'
/** Token counts summed over every model call a role made; cache reads are disjoint from uncached input. */
export interface TeamUsage { input: number; output: number; cached: number }
export const TEAM_ROLE_LABELS: Record<TeamRole, string> = { lead: 'Team lead', researcher: 'Researcher', developer: 'Developer',
  tester: 'Tester', reviewer: 'Reviewer', ops: 'Ops' }
/** The built-in role instructions a profile can override with its own `instructions`. */
const ROLE_INSTRUCTIONS: Record<TeamRole, string> = {
  lead: 'You lead a six-person engineering team. Turn the task into a short plan with workstreams, acceptance criteria and risks. Do not edit files.',
  researcher: 'You research the repository and, when needed, the web. Return concise facts with file paths and links. Do not edit files.',
  developer: 'You implement the task in the working directory. Keep the change scoped, run the relevant checks, and report the changed files and commands.',
  tester: 'You test the implementation. Add or adjust tests only where needed, run them, and report the exact commands and results. Do not change product code unless the task requires it. End your report with one line exactly `VERDICT: PASS` or `VERDICT: FAIL`; use PASS only when every acceptance criterion is met and the checks pass, otherwise FAIL and list the blocking issues.',
  reviewer: 'You review the implementation against the task and the repository conventions. Do not edit source files. For a product or feature design whose result can be verified visually (UI, layout, interaction or rendered output), capture a real screenshot of the implemented result with the available browser or screenshot tooling, save it under the working directory, and include its absolute path as evidence. If a screenshot cannot be captured, say why and mark the visual acceptance check unverified. End your report with one line exactly `VERDICT: PASS` or `VERDICT: FAIL`; use PASS only when every acceptance criterion is met, otherwise FAIL and list the blocking findings. Report findings by severity with file and line references.',
  ops: 'You inspect CI, logs and deployment state. Run read-only commands; do not edit the repository. Report failures and the command that showed them.',
}

/** One role's latest run in a team. */
export interface TeamMember { role: TeamRole; profile: string | null; state: MemberState; session_id?: string; output?: string; error?: string
  started_at?: string; ended_at?: string; round?: number; verdict?: MemberVerdict; usage?: TeamUsage }
/** A durable team record, listed and inspected by the panel. */
export interface Team { id: string; title: string; task: string; state: TeamState; created_at: string; updated_at: string
  run_started_at?: string; parent_session_id: string; directory: string; members: TeamMember[]; summary?: string; error?: string
  outcome?: TeamOutcome; rounds?: number; usage?: TeamUsage; continuations?: number; previous_summary?: string
  previous_outcome?: TeamOutcome; previous_error?: string; continued_from?: string; continued_from_title?: string
  continuation?: string; continuation_recipients?: TeamRole[] }
export interface TeamSummary { id: string; title: string; state: TeamState; created_at: string; updated_at: string
  run_started_at?: string; members: { role: TeamRole; state: MemberState }[]; summary?: string; outcome?: TeamOutcome
  rounds?: number; usage?: TeamUsage; continuations?: number; continued_from?: string; continued_from_title?: string }
/** A readable image or text file from a team's working directory, encoded for the panel preview. */
export interface TeamFile { name: string; mime: string; data: string }
const IMAGE_MIMES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' }
const TEXT_MIMES: Record<string, string> = { '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8', '.yml': 'text/yaml; charset=utf-8', '.toml': 'text/plain; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.jsx': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8', '.tsx': 'text/typescript; charset=utf-8', '.py': 'text/x-python; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.sh': 'text/x-shellscript; charset=utf-8' }
const FILE_LIMIT = 8 * 1024 * 1024

/** Context carried from a finished team into a new continuation run. */
interface Continuation { source: Team; instruction: string }

/** Structural subset of DSH's subagent service, kept local so the bundle does not depend on the package at build time. */
interface Activation { childId: string; result: Promise<{ output: readonly { type: string; text?: string }[]; stopReason: string; diagnostic?: string }>
  dispose(): Promise<void> }
interface Subagents { startActivation(spec: { provider: string; label: string; request: { prompt: ContentBlock[]; parent: Agent; cwd?: string; agentPreset?: string;
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: string } }; signal: AbortSignal; delivery: 'parent' | 'caller' }): Promise<Activation> }

/** Structural subset of DSH's model catalog, used to keep image input from being silently dropped for text-only roles. */
interface Llm { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[] }> }
interface ModelRoute { provider: string; model: string }
/** A child Session's assistant-message usage, observed from DSH's session event stream. */
interface UsageEvent { type: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } }
interface UsageSession { id: string }
interface SessionEvents { snapshotEvents(): readonly UsageEvent[] }
interface AgentLookup { get(id: string): { session: SessionEvents } | undefined }

export interface TeamsHost { context: Context; store: Pick<Store, 'get' | 'set' | 'atomic'>; masterId: string; stateDir: string; settings(): Settings
  logger: { warn(message: string): void } }
const MAX_ACTIVE_TEAMS = 3
/** At most this many implementation/verification rounds, including the first; later rounds are lead-directed repairs. */
const MAX_ROUNDS = 3
const OUTPUT_LIMIT = 24_000
const clip = (text: string): string => text.length <= OUTPUT_LIMIT ? text : `${text.slice(0, OUTPUT_LIMIT)}\n… [truncated]`
const textOf = (blocks: readonly { type: string; text?: string }[]): string => blocks.filter(block => block.type === 'text' && block.text)
  .map(block => block.text).join('\n').trim()
const addUsage = (total: TeamUsage | undefined, usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }): TeamUsage => ({
  input: (total?.input ?? 0) + (usage.inputTokens ?? 0), output: (total?.output ?? 0) + (usage.outputTokens ?? 0),
  cached: (total?.cached ?? 0) + (usage.cacheReadTokens ?? 0) })
const sumUsage = (members: readonly TeamMember[]): TeamUsage | undefined => {
  const present = members.filter(member => member.usage)
  if (!present.length) return undefined
  return present.reduce<TeamUsage>((total, member) => addUsage(total, { inputTokens: member.usage!.input,
    outputTokens: member.usage!.output, cacheReadTokens: member.usage!.cached }), { input: 0, output: 0, cached: 0 })
}
const parseVerdict = (text: string): MemberVerdict | undefined => {
  const matches = [...text.matchAll(/\bVERDICT\s*:\s*(PASS|FAIL)\b/gi)]
  const value = matches.at(-1)?.[1]?.toLowerCase()
  return value === 'pass' ? 'pass' : value === 'fail' ? 'fail' : undefined
}
const outcomeText = (outcome: TeamOutcome): string => outcome === 'achieved' ? 'ACHIEVED'
  : outcome === 'not_achieved' ? 'NOT ACHIEVED' : 'UNVERIFIED'

/**
 * Creates and runs teams. A team starts six managed subagents from the configured worker roles; the lead plans, the
 * researcher and developer work in parallel, the tester and reviewer verify, ops inspects CI, and the lead synthesizes.
 * Executions are transient: a restart marks a running team failed instead of silently resuming unknown children.
 */
export class Teams {
  private readonly active = new Map<string, AbortController>()
  /** Child Session id → the team role whose token usage it contributes to. */
  private readonly usageTargets = new Map<string, { team: string; role: TeamRole }>()
  /** Child Session ids whose usage was already observed live, so a final snapshot does not double-count it. */
  private readonly usageObserved = new Set<string>()
  constructor(private readonly host: TeamsHost) {
    const context = host.context as unknown as { on?: (event: 'session/event', listener: (session: UsageSession, event: UsageEvent) => void) => void }
    context.on?.('session/event', (session, event) => this.observeUsage(session.id, event))
  }

  /**
   * Lists teams newest first, with member states and a short summary. Descendants of an older continuation are hidden
   * so one card represents a lineage; the visible latest card links back to its `continued_from` record.
   */
  list(): TeamSummary[] {
    const ids = [...(this.host.store.get(KV.teams.index) ?? [])].reverse()
    const linked = new Set(ids.flatMap(id => { const team = this.get(id); return team?.continued_from && ids.includes(team.continued_from)
      ? [team.continued_from] : [] }))
    return ids.filter(id => !linked.has(id)).flatMap(id => { const team = this.get(id); return team ? [{ id: team.id, title: team.title, state: team.state,
      created_at: team.created_at, updated_at: team.updated_at, ...team.run_started_at ? { run_started_at: team.run_started_at } : {},
      members: team.members.map(member => ({ role: member.role,
        state: member.state })), ...team.summary ? { summary: team.summary } : {}, ...team.outcome ? { outcome: team.outcome } : {},
      ...team.rounds ? { rounds: team.rounds } : {}, ...team.usage ? { usage: team.usage } : {},
      ...team.continuations ? { continuations: team.continuations } : {},
      ...team.continued_from ? { continued_from: team.continued_from } : {},
      ...team.continued_from_title ? { continued_from_title: team.continued_from_title } : {} }] : [] })
  }
  /** Reads one team, or undefined when the id is unknown. */
  get(id: string): Team | undefined { return this.host.store.get(KV.teams.record(id)) }
  /** Number of teams currently executing. */
  get activeCount(): number { return this.active.size }

  /**
   * Reads an image or text file referenced by a team output. Only paths that resolve inside the team's working directory
   * are served; `realpath` rejects symlinks that escape it. Returns undefined for missing, outside, or unsupported files.
   */
  readFile(id: string, requested: string): TeamFile | undefined {
    const team = this.get(id)
    if (!team) return undefined
    try {
      const root = realpathSync(team.directory)
      const raw = requested.replace(/^file:\/\//, '')
      const target = realpathSync(raw.startsWith('/') ? raw : resolve(root, raw))
      if (target !== root && !target.startsWith(`${root}${sep}`)) return undefined
      const stat = statSync(target)
      if (!stat.isFile() || stat.size > FILE_LIMIT) return undefined
      const extension = extname(target).toLowerCase()
      const mime = IMAGE_MIMES[extension] ?? TEXT_MIMES[extension]
      if (!mime) return undefined
      return { name: basename(target), mime, data: readFileSync(target).toString('base64') }
    } catch { return undefined }
  }

  /** Marks teams left running by a previous process as failed: their subagents cannot be recovered across a restart. */
  recover(): void {
    for (const id of this.host.store.get(KV.teams.index) ?? []) {
      const team = this.get(id)
      if (!team || team.state !== 'running') continue
      team.state = 'failed'; team.error = 'The process restarted while this team was running'
      for (const member of team.members) if (member.state === 'running') { member.state = 'failed'; member.error ??= team.error }
      this.save(team)
    }
  }

  /** Aborts every running team, for shutdown. */
  stopAll(): void { for (const id of [...this.active.keys()]) this.stop(id) }

  /** The lead's model and whether it explicitly accepts image input; undefined when the route or catalog entry cannot say. */
  async leadImageCapability(parent?: Agent, signal?: AbortSignal): Promise<{ model: string; supported: boolean } | undefined> {
    const route = this.routeOf('lead', parent)
    if (!route) return undefined
    const supported = await this.imageCapability('lead', parent, signal)
    return supported === undefined ? undefined : { model: route.model, supported }
  }

  /**
   * Creates and starts a team for `task`, sending any attached images to every role; refuses while paused or when too many
   * teams already run. A continuation keeps its source record untouched and starts a linked run in the same directory.
   */
  create(task: string, parent?: Agent, title = '', requestedDirectory?: string, images: readonly ImageBlock[] = []): Team {
    return this.start(task, parent, title, requestedDirectory, images)
  }

  /**
   * Continues a finished team in place: the same card and id are reused, the previous attempt is kept for the prompt and
   * as `previous_summary`, and all six roles run again with the optional instruction. No duplicate Team is created.
   */
  continueTeam(id: string, parent?: Agent, instruction = '', images: readonly ImageBlock[] = []): Team {
    const source = this.get(id)
    if (!source) throw new Error(`Team not found: ${id}`)
    if (source.state === 'running') throw new Error('Team is still running; wait for it to finish before continuing')
    const { agent, settings } = this.ready(parent)
    const directory = resolve(source.directory)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (!statSync(directory).isDirectory()) throw new Error(`Team directory is not a directory: ${directory}`)
    const previous = structuredClone(source)
    const priorSummary = source.summary ?? source.previous_summary
    const priorOutcome = source.outcome ?? source.previous_outcome
    const priorError = source.error ?? source.previous_error
    previous.summary = priorSummary
    previous.outcome = priorOutcome
    const text = instruction.trim()
    const at = new Date().toISOString()
    source.state = 'running'; source.updated_at = at; source.run_started_at = at; source.parent_session_id = agent.id
    source.directory = directory; source.continuations = (source.continuations ?? 0) + 1
    source.continuation_recipients = [...TEAM_ROLES]
    if (text) source.continuation = text; else delete source.continuation
    delete source.outcome; delete source.error; delete source.summary; delete source.rounds; delete source.usage
    if (priorSummary) source.previous_summary = priorSummary; else delete source.previous_summary
    if (priorOutcome) source.previous_outcome = priorOutcome; else delete source.previous_outcome
    if (priorError) source.previous_error = priorError; else delete source.previous_error
    const profiles = settings.executor.profiles
    source.members = TEAM_ROLES.map(role => ({ role, profile: profiles[role] ? role : settings.executor.defaultProfile ?? null, state: 'idle' }))
    this.save(source)
    this.moveToEnd(source.id)
    this.launch(source, agent, images, { source: previous, instruction: text })
    return source
  }

  /** Checks pause, capacity and the parent Session once, for both a new team and an in-place continuation. */
  private ready(parent?: Agent): { agent: Agent; settings: Settings } {
    const settings = this.host.settings()
    if (settings.paused) throw new Error('Processing is paused; resume it before starting a team')
    const limit = Math.min(MAX_ACTIVE_TEAMS, Math.max(1, settings.executor.maxWorkers))
    if (this.active.size >= limit) throw new Error(`At most ${limit} teams run at once; wait for one to finish`)
    const agent = parent ?? this.host.context.agents.get(this.host.masterId as never)
    if (!agent) throw new Error('The main Session is not running; open it once before starting a team')
    return { agent, settings }
  }

  private start(task: string, parent: Agent | undefined, title: string, requestedDirectory: string | undefined,
    images: readonly ImageBlock[]): Team {
    const { agent, settings } = this.ready(parent)
    const directory = resolve(requestedDirectory ?? (settings.executor.teamDirectory || join(this.host.stateDir, 'team')))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (!statSync(directory).isDirectory()) throw new Error(`Team directory is not a directory: ${directory}`)
    const at = new Date().toISOString()
    const id = `team-${key('team', task, agent.id, at)}`
    const profiles = settings.executor.profiles
    const team: Team = { id, title: (title.trim() || task.trim().split('\n')[0]!.slice(0, 80)) || 'Agent team', task, state: 'running',
      created_at: at, updated_at: at, run_started_at: at, parent_session_id: agent.id, directory,
      members: TEAM_ROLES.map(role => ({ role, profile: profiles[role] ? role : settings.executor.defaultProfile ?? null, state: 'idle' })) }
    this.save(team, true)
    this.launch(team, agent, images)
    return team
  }

  /** Starts execution for an already persisted/updated team and tracks its abort controller. */
  private launch(team: Team, agent: Agent, images: readonly ImageBlock[], continuation?: Continuation): void {
    const controller = new AbortController()
    this.active.set(team.id, controller)
    void this.execute(team, agent, controller.signal, images, continuation).catch(error => {
      this.finish(team, 'failed', String(error).slice(0, 1000))
    }).finally(() => { this.active.delete(team.id) })
  }

  /** Moves a continued team to the front of the list without duplicating its index entry. */
  private moveToEnd(id: string): void {
    const index = this.host.store.get(KV.teams.index) ?? []
    if (index.includes(id)) this.host.store.set(KV.teams.index, [...index.filter(item => item !== id), id])
  }

  /** Stops a running team and its member activations. Returns whether it was running. */
  stop(id: string): boolean {
    const controller = this.active.get(id)
    if (!controller) return false
    controller.abort()
    const team = this.get(id)
    if (team) {
      for (const member of team.members) if (member.state === 'running') { member.state = 'stopped'; member.ended_at = new Date().toISOString() }
      this.finish(team, 'stopped')
    }
    this.active.delete(id)
    return true
  }

  private save(team: Team, created = false): void {
    team.updated_at = new Date().toISOString()
    const usage = sumUsage(team.members)
    if (usage) team.usage = usage
    else delete team.usage
    this.host.store.atomic(() => {
      this.host.store.set(KV.teams.record(team.id), team)
      if (created) this.host.store.set(KV.teams.index, [...(this.host.store.get(KV.teams.index) ?? []), team.id])
    })
  }

  /** Adds one role's assistant-message usage as it is observed; a child Session's later messages accumulate onto the same role. */
  private observeUsage(sessionId: string, event: UsageEvent): void {
    if (event.type !== 'assistant/message' || !event.usage) return
    const target = this.usageTargets.get(sessionId)
    if (!target) return
    this.usageObserved.add(sessionId)
    this.recordUsage(target.team, target.role, event.usage)
  }

  private recordUsage(teamId: string, role: TeamRole, usage: NonNullable<UsageEvent['usage']>): void {
    const team = this.get(teamId)
    if (!team) return
    const member = this.member(team, role)
    member.usage = addUsage(member.usage, usage)
    this.save(team)
  }

  /**
   * A fallback for a child whose live events were missed. Read the Agent directly: the Cordis `sessions` service is not
   * injected into this plugin, and touching it throws "cannot get property sessions without inject". Usage accounting
   * must never fail a role, so any lookup error simply yields no fallback.
   */
  private snapshotUsage(sessionId: string): TeamUsage | undefined {
    try {
      const agents = (this.host.context as unknown as { agents?: AgentLookup }).agents
      const events = agents?.get(sessionId)?.session.snapshotEvents() ?? []
      let usage: TeamUsage | undefined
      for (const event of events) if (event.type === 'assistant/message' && event.usage) usage = addUsage(usage, event.usage)
      return usage
    } catch { return undefined }
  }
  private finish(team: Team, state: TeamState, error?: string): void {
    team.state = state
    if (error) team.error = error
    for (const member of team.members) if (member.state === 'running') { member.state = state === 'done' ? 'done' : 'failed'; member.ended_at = new Date().toISOString() }
    this.save(team)
  }
  private member(team: Team, role: TeamRole): TeamMember {
    return team.members.find(item => item.role === role)!
  }

  /** The model route a role will use: its profile override, else the parent Session's route. */
  private routeOf(role: TeamRole, parent?: Agent): ModelRoute | undefined {
    const settings = this.host.settings()
    const profileId = settings.executor.profiles[role] ? role : settings.executor.defaultProfile ?? null
    const model = (profileId ? settings.executor.profiles[profileId]?.model : undefined) ?? settings.executor.model
    if (model) return { provider: model.provider, model: model.model }
    const header = parent?.session?.requestHeader?.()?.config
    const provider = header?.provider ?? parent?.options?.provider
    const id = header?.model ?? parent?.options?.model
    return provider && id ? { provider, model: id } : undefined
  }

  /** Whether the role's model explicitly declares image input; undefined when the route or catalog entry cannot say. */
  private async imageCapability(role: TeamRole, parent?: Agent, signal?: AbortSignal): Promise<boolean | undefined> {
    const route = this.routeOf(role, parent)
    const llm = (this.host.context as unknown as { llm?: Llm }).llm
    if (!route || !llm) return undefined
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model, signal)
      return info.inputModalities === undefined ? undefined : info.inputModalities.includes('image')
    } catch { return undefined }
  }

  /** Builds a role prompt with the role text first and the task images after it; a model that rejects images gets a note instead. */
  private async promptFor(role: TeamRole, text: string, parent: Agent, signal: AbortSignal, images: readonly ImageBlock[]): Promise<ContentBlock[]> {
    if (!images.length) return [{ type: 'text', text }]
    if (await this.imageCapability(role, parent, signal) === false) {
      const omitted = images.length === 1 ? 'An attached image was' : `${images.length} attached images were`
      return [{ type: 'text', text: `${text}\n\n[${omitted} omitted: this role's model does not accept image input.]` }]
    }
    return [{ type: 'text', text }, ...images]
  }

  /** Runs one role to completion and returns its text. Attached images follow the text when the role's model accepts them. */
  private async run(team: Team, role: TeamRole, prompt: string, parent: Agent, signal: AbortSignal, images: readonly ImageBlock[] = [], round = 1): Promise<string> {
    const member = this.member(team, role)
    const settings = this.host.settings()
    const profileId = member.profile
    const profile = profileId ? settings.executor.profiles[profileId] : undefined
    const model = profile?.model ?? settings.executor.model
    const subagents = (this.host.context as unknown as { subagents?: Subagents }).subagents
    if (!subagents) throw new Error('The subagent service is not available in this DSH profile')
    member.state = 'running'; member.started_at = new Date().toISOString(); member.round = round; delete member.error
    delete member.verdict; this.save(team)
    const agentOptions = model ? { provider: model.provider, model: model.model, ...model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {} } : undefined
    const rolePrompt = profile?.instructions ? `${ROLE_INSTRUCTIONS[role]}\n\n${profile.instructions}` : ROLE_INSTRUCTIONS[role]
    const text = `${rolePrompt}\n\nTask:\n${prompt}\n\nWork in the current working directory. Do not ask questions; make the best decision and report evidence.`
    const content = await this.promptFor(role, text, parent, signal, images)
    let activation: Activation
    try {
      activation = await subagents.startActivation({ provider: 'spawn', label: `${team.title} · ${TEAM_ROLE_LABELS[role]}`,
        request: { prompt: content, parent, cwd: team.directory, ...(profile?.preset ? { agentPreset: profile.preset } : { agentPreset: 'dsh-superagent-worker' }),
          ...agentOptions ? { agentOptions } : {} }, signal, delivery: 'caller' })
    } catch (error) {
      member.state = 'failed'; member.error = String(error).slice(0, 1000); member.ended_at = new Date().toISOString(); this.save(team)
      throw error
    }
    const childId = activation.childId
    member.session_id = childId
    this.usageTargets.set(childId, { team: team.id, role })
    this.save(team)
    try {
      const result = await activation.result
      const output = textOf(result.output)
      if (role === 'tester' || role === 'reviewer') {
        const verdict = parseVerdict(output)
        if (verdict) member.verdict = verdict; else delete member.verdict
      }
      member.output = clip(output || result.diagnostic || '')
      member.state = result.stopReason === 'completed' ? 'done' : 'failed'
      if (result.stopReason !== 'completed') member.error = result.diagnostic ?? result.stopReason
      if (!this.usageObserved.has(childId)) {
        const usage = this.snapshotUsage(childId)
        if (usage) this.recordUsage(team.id, role, { inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cached })
      }
      member.ended_at = new Date().toISOString(); this.save(team)
      return member.output
    } catch (error) {
      member.state = signal.aborted ? 'stopped' : 'failed'; member.error = String(error).slice(0, 1000); member.ended_at = new Date().toISOString(); this.save(team)
      return ''
    } finally {
      try {
        await activation.dispose().catch(error => this.host.logger.warn(`team ${team.id}: subagent cleanup failed: ${String(error)}`))
      } finally {
        this.usageTargets.delete(childId); this.usageObserved.delete(childId)
      }
    }
  }

  private contextOf(team: Team, roles: readonly TeamRole[]): string {
    return roles.flatMap(role => { const member = this.member(team, role); return member.output ? `## ${TEAM_ROLE_LABELS[role]}\n${member.output}` : [] }).join('\n\n')
  }

  /** The prior attempt's summary and the user's request, given to the lead and developer of a continuation run. */
  private continuationContext(continuation: Continuation): string {
    const source = continuation.source
    const evidence = source.summary ?? this.contextOf(source, TEAM_ROLES)
    return [
      `This run continues an earlier attempt (${source.id}) that ended as ${source.outcome ?? 'unverified'}.`,
      `Previous attempt evidence:\n${clip(evidence)}`,
      continuation.instruction ? `The user's additional instruction:\n${continuation.instruction}`
        : 'The user gave no additional instruction; finish the original task.',
      'The working directory still contains the previous attempt. Inspect the current state and continue it instead of starting over.',
    ].join('\n\n')
  }

  /** A short continuation note sent to every role, so each knows why the working directory already has changes. */
  private continuationNote(continuation: Continuation): string {
    return `${continuation.instruction ? `The user's continuation request: ${continuation.instruction}` : 'This run continues earlier work.'}\n` +
      'Continue from the existing state; inspect the working directory and do not start over.'
  }

  private async execute(team: Team, parent: Agent, signal: AbortSignal, images: readonly ImageBlock[] = [],
    continuation?: Continuation): Promise<void> {
    const task = team.task
    const background = continuation ? this.continuationContext(continuation) : ''
    const notice = continuation ? this.continuationNote(continuation) : ''
    const plan = await this.run(team, 'lead', `${task}\n\n${background ? `${background}\n\n` : ''}First produce the plan only; the team implements after it.`,
      parent, signal, images)
    if (signal.aborted) return
    let round = 1
    let history = ''
    let verification = ''
    let outcome: TeamOutcome = 'unverified'
    while (true) {
      team.rounds = round; this.save(team)
      if (round === 1) {
        await Promise.all([
          this.run(team, 'researcher', `${task}\n\nPlan:\n${plan}\n\n${notice ? `${notice}\n\n` : ''}Gather the repository and external context the implementer needs.`,
            parent, signal, images, round),
          this.run(team, 'developer', `${task}\n\nPlan:\n${plan}\n\n${background ? `${background}\n\n` : ''}Implement the task now.`,
            parent, signal, images, round),
        ])
      } else {
        const previous = this.contextOf(team, ['researcher', 'developer'])
        const repair = await this.run(team, 'lead', `${task}\n\nPlan:\n${plan}\n\nRound ${round - 1} did not pass verification:\n${verification}\n\n` +
          `${notice ? `${notice}\n\n` : ''}Write concise repair instructions for the developer: the concrete changes, acceptance criteria and checks to rerun. Do not edit files.`,
        parent, signal, images, round)
        if (signal.aborted) return
        await this.run(team, 'developer', `${task}\n\nPlan:\n${plan}\n\nCurrent implementation evidence:\n${previous}\n\n` +
          `Verification failure:\n${verification}\n\nLead repair instructions:\n${repair}\n\n${notice ? `${notice}\n\n` : ''}Apply the repair now.`,
        parent, signal, images, round)
      }
      if (signal.aborted) return
      const work = this.contextOf(team, ['researcher', 'developer'])
      const prior = history ? `\n\nEarlier verification:\n${history}` : ''
      await Promise.all([
        this.run(team, 'tester', `${task}\n\nPlan:\n${plan}\n\n${work}${prior}${notice ? `\n\n${notice}` : ''}\n\nTest the implementation and report the commands and results.`,
          parent, signal, images, round),
        this.run(team, 'reviewer', `${task}\n\nPlan:\n${plan}\n\n${work}${prior}${notice ? `\n\n${notice}` : ''}\n\nReview the implementation and report findings; do not edit. ` +
          'If the task is a product or feature design that can be verified visually, include a real screenshot and its path as evidence.', parent, signal, images, round),
      ])
      if (signal.aborted) return
      verification = this.contextOf(team, ['tester', 'reviewer'])
      const tester = this.member(team, 'tester'), reviewer = this.member(team, 'reviewer')
      const testerVerdict = tester.verdict, reviewerVerdict = reviewer.verdict
      this.save(team)
      if (tester.state === 'failed' || reviewer.state === 'failed') { outcome = 'not_achieved'; break }
      if (testerVerdict === 'pass' && reviewerVerdict === 'pass') { outcome = 'achieved'; break }
      if (testerVerdict !== 'fail' && reviewerVerdict !== 'fail') { outcome = 'unverified'; break }
      if (round >= MAX_ROUNDS) { outcome = 'not_achieved'; break }
      history = clip(`${history}\n\n## Round ${round}\n${verification}`)
      round += 1
    }
    if (signal.aborted) return
    team.rounds = round; this.save(team)
    const finalWork = this.contextOf(team, ['researcher', 'developer'])
    await this.run(team, 'ops', `${task}\n\n${finalWork}\n\nVerification:\n${verification}\n\n${notice ? `${notice}\n\n` : ''}Inspect CI and repository status; do not edit.`,
      parent, signal, images, round)
    if (signal.aborted) return
    const evidence = this.contextOf(team, TEAM_ROLES)
    const synthesis = await this.run(team, 'lead', `${task}\n\nPlan:\n${plan}\n\nAll team evidence:\n${evidence}\n\n` +
      `${notice ? `${notice}\n\n` : ''}Final verification outcome: ${outcomeText(outcome)} after round ${round}. Synthesize the final result: what changed, ` +
      'what was verified, what failed, and what a human should do next. Do not claim success when the outcome is NOT ACHIEVED or UNVERIFIED. ' +
      'This is the team summary.', parent, signal, images, round)
    team.summary = clip(synthesis)
    team.outcome = outcome
    team.state = 'done'
    this.save(team)
  }

}
