/** Six-role Agent Team runtime: /team creates a team, runs its roles as managed subagents, and records evidence for the panel. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { key } from '../core/ids.ts'
import type { Settings } from '../policy.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

export const TEAM_ROLES = ['lead', 'researcher', 'developer', 'tester', 'reviewer', 'ops'] as const
export type TeamRole = typeof TEAM_ROLES[number]
export type TeamState = 'running' | 'done' | 'failed' | 'stopped'
export type MemberState = 'idle' | 'running' | 'done' | 'failed' | 'stopped'
export const TEAM_ROLE_LABELS: Record<TeamRole, string> = { lead: 'Team lead', researcher: 'Researcher', developer: 'Developer',
  tester: 'Tester', reviewer: 'Reviewer', ops: 'Ops' }
/** The built-in role instructions a profile can override with its own `instructions`. */
const ROLE_INSTRUCTIONS: Record<TeamRole, string> = {
  lead: 'You lead a six-person engineering team. Turn the task into a short plan with workstreams, acceptance criteria and risks. Do not edit files.',
  researcher: 'You research the repository and, when needed, the web. Return concise facts with file paths and links. Do not edit files.',
  developer: 'You implement the task in the working directory. Keep the change scoped, run the relevant checks, and report the changed files and commands.',
  tester: 'You test the implementation. Add or adjust tests only where needed, run them, and report the exact commands and results. Do not change product code unless the task requires it.',
  reviewer: 'You review the implementation against the task and the repository conventions. Do not edit files. Report findings by severity with file and line references.',
  ops: 'You inspect CI, logs and deployment state. Run read-only commands; do not edit the repository. Report failures and the command that showed them.',
}

/** One role's latest run in a team. */
export interface TeamMember { role: TeamRole; profile: string | null; state: MemberState; session_id?: string; output?: string; error?: string
  started_at?: string; ended_at?: string }
/** A durable team record, listed and inspected by the panel. */
export interface Team { id: string; title: string; task: string; state: TeamState; created_at: string; updated_at: string
  parent_session_id: string; members: TeamMember[]; summary?: string; error?: string }
export interface TeamSummary { id: string; title: string; state: TeamState; created_at: string; updated_at: string
  members: { role: TeamRole; state: MemberState }[]; summary?: string }

/** Structural subset of DSH's subagent service, kept local so the bundle does not depend on the package at build time. */
interface Activation { childId: string; result: Promise<{ output: readonly { type: string; text?: string }[]; stopReason: string; diagnostic?: string }>
  dispose(): Promise<void> }
interface Subagents { startActivation(spec: { provider: string; label: string; request: { prompt: ContentBlock[]; parent: Agent; agentPreset?: string;
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: string } }; signal: AbortSignal; delivery: 'parent' | 'caller' }): Promise<Activation> }

export interface TeamsHost { context: Context; store: Pick<Store, 'get' | 'set' | 'atomic'>; masterId: string; settings(): Settings
  logger: { warn(message: string): void } }
const MAX_ACTIVE_TEAMS = 3
const OUTPUT_LIMIT = 24_000
const clip = (text: string): string => text.length <= OUTPUT_LIMIT ? text : `${text.slice(0, OUTPUT_LIMIT)}\n… [truncated]`
const textOf = (blocks: readonly { type: string; text?: string }[]): string => blocks.filter(block => block.type === 'text' && block.text)
  .map(block => block.text).join('\n').trim()

/**
 * Creates and runs teams. A team starts six managed subagents from the configured worker roles; the lead plans, the
 * researcher and developer work in parallel, the tester and reviewer verify, ops inspects CI, and the lead synthesizes.
 * Executions are transient: a restart marks a running team failed instead of silently resuming unknown children.
 */
export class Teams {
  private readonly active = new Map<string, AbortController>()
  constructor(private readonly host: TeamsHost) {}

  /** Lists teams newest first, with member states and a short summary. */
  list(): TeamSummary[] {
    const ids = [...(this.host.store.get(KV.teams.index) ?? [])].reverse()
    return ids.flatMap(id => { const team = this.get(id); return team ? [{ id: team.id, title: team.title, state: team.state,
      created_at: team.created_at, updated_at: team.updated_at, members: team.members.map(member => ({ role: member.role,
        state: member.state })), ...team.summary ? { summary: team.summary } : {} }] : [] })
  }
  /** Reads one team, or undefined when the id is unknown. */
  get(id: string): Team | undefined { return this.host.store.get(KV.teams.record(id)) }
  /** Number of teams currently executing. */
  get activeCount(): number { return this.active.size }

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

  /** Creates and starts a team for `task`; refuses while paused or when too many teams already run. */
  create(task: string, parent?: Agent, title = ''): Team {
    const settings = this.host.settings()
    if (settings.paused) throw new Error('Processing is paused; resume it before starting a team')
    const limit = Math.min(MAX_ACTIVE_TEAMS, Math.max(1, settings.executor.maxWorkers))
    if (this.active.size >= limit) throw new Error(`At most ${limit} teams run at once; wait for one to finish`)
    const agent = parent ?? this.host.context.agents.get(this.host.masterId as never)
    if (!agent) throw new Error('The main Session is not running; open it once before starting a team')
    const at = new Date().toISOString()
    const id = `team-${key('team', task, agent.id, at)}`
    const profiles = settings.executor.profiles
    const team: Team = { id, title: (title.trim() || task.trim().split('\n')[0]!.slice(0, 80)) || 'Agent team', task, state: 'running',
      created_at: at, updated_at: at, parent_session_id: agent.id, members: TEAM_ROLES.map(role => ({ role,
        profile: profiles[role] ? role : settings.executor.defaultProfile ?? null, state: 'idle' })) }
    this.save(team, true)
    const controller = new AbortController()
    this.active.set(id, controller)
    void this.execute(team, agent, controller.signal).catch(error => {
      this.finish(team, 'failed', String(error).slice(0, 1000))
    }).finally(() => { this.active.delete(id) })
    return team
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
    this.host.store.atomic(() => {
      this.host.store.set(KV.teams.record(team.id), team)
      if (created) this.host.store.set(KV.teams.index, [...(this.host.store.get(KV.teams.index) ?? []), team.id])
    })
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

  /** Runs one role to completion and returns its text. Failures are recorded on the member and do not stop the other roles. */
  private async run(team: Team, role: TeamRole, prompt: string, parent: Agent, signal: AbortSignal): Promise<string> {
    const member = this.member(team, role)
    const settings = this.host.settings()
    const profileId = member.profile
    const profile = profileId ? settings.executor.profiles[profileId] : undefined
    const model = profile?.model ?? settings.executor.model
    const subagents = (this.host.context as unknown as { subagents?: Subagents }).subagents
    if (!subagents) throw new Error('The subagent service is not available in this DSH profile')
    member.state = 'running'; member.started_at = new Date().toISOString(); delete member.error; this.save(team)
    const agentOptions = model ? { provider: model.provider, model: model.model, ...model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {} } : undefined
    const rolePrompt = profile?.instructions ? `${ROLE_INSTRUCTIONS[role]}\n\n${profile.instructions}` : ROLE_INSTRUCTIONS[role]
    const text = `${rolePrompt}\n\nTask:\n${prompt}\n\nWork in the current working directory. Do not ask questions; make the best decision and report evidence.`
    let activation: Activation
    try {
      activation = await subagents.startActivation({ provider: 'spawn', label: `${team.title} · ${TEAM_ROLE_LABELS[role]}`,
        request: { prompt: [{ type: 'text', text }], parent, ...(profile?.preset ? { agentPreset: profile.preset } : { agentPreset: 'dsh-superagent-worker' }),
          ...agentOptions ? { agentOptions } : {} }, signal, delivery: 'caller' })
    } catch (error) {
      member.state = 'failed'; member.error = String(error).slice(0, 1000); member.ended_at = new Date().toISOString(); this.save(team)
      throw error
    }
    member.session_id = activation.childId; this.save(team)
    try {
      const result = await activation.result
      const output = textOf(result.output)
      member.output = clip(output || result.diagnostic || '')
      member.state = result.stopReason === 'completed' ? 'done' : 'failed'
      if (result.stopReason !== 'completed') member.error = result.diagnostic ?? result.stopReason
      member.ended_at = new Date().toISOString(); this.save(team)
      return member.output
    } catch (error) {
      member.state = signal.aborted ? 'stopped' : 'failed'; member.error = String(error).slice(0, 1000); member.ended_at = new Date().toISOString(); this.save(team)
      return ''
    } finally {
      await activation.dispose().catch(error => this.host.logger.warn(`team ${team.id}: subagent cleanup failed: ${String(error)}`))
    }
  }

  private contextOf(team: Team, roles: readonly TeamRole[]): string {
    return roles.flatMap(role => { const member = this.member(team, role); return member.output ? `## ${TEAM_ROLE_LABELS[role]}\n${member.output}` : [] }).join('\n\n')
  }

  private async execute(team: Team, parent: Agent, signal: AbortSignal): Promise<void> {
    const task = team.task
    const plan = await this.run(team, 'lead', `${task}\n\nFirst produce the plan only; the team implements after it.`, parent, signal)
    if (signal.aborted) return
    await Promise.all([
      this.run(team, 'researcher', `${task}\n\nPlan:\n${plan}\n\nGather the repository and external context the implementer needs.`, parent, signal),
      this.run(team, 'developer', `${task}\n\nPlan:\n${plan}\n\nImplement the task now.`, parent, signal),
    ])
    if (signal.aborted) return
    const work = this.contextOf(team, ['lead', 'researcher', 'developer'])
    await Promise.all([
      this.run(team, 'tester', `${task}\n\n${work}\n\nTest the implementation and report the commands and results.`, parent, signal),
      this.run(team, 'reviewer', `${task}\n\n${work}\n\nReview the implementation and report findings; do not edit.`, parent, signal),
    ])
    if (signal.aborted) return
    await this.run(team, 'ops', `${task}\n\n${work}\n\nInspect CI and repository status; do not edit.`, parent, signal)
    if (signal.aborted) return
    const evidence = this.contextOf(team, TEAM_ROLES)
    const synthesis = await this.run(team, 'lead', `${task}\n\nAll team evidence:\n${evidence}\n\nSynthesize the final result: what changed, what was verified, ` +
      'what failed, and what a human should do next. This is the team summary.', parent, signal)
    team.summary = clip(synthesis)
    team.state = 'done'
    this.save(team)
  }
}
