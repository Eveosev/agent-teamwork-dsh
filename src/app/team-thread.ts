/** Types for the durable Team thread: messages, turns, router decisions, approvals, and human ingress. */
import type { TeamRole } from './teams.ts'

/** Execution shape of a Team. `pipeline` is the original fixed sequence; `open` allows addressed role turns. */
export type TeamMode = 'open' | 'pipeline'
/** Whether a live Team is executing, waiting for a person, or terminal. */
export type TeamActivity = 'active' | 'waiting' | 'terminal'
/** What a waiting Team needs before it can continue. */
export type TeamWaitingFor = 'human' | 'approval' | 'router'
export type TeamEventKind = 'message' | 'turn' | 'router' | 'approval' | 'system'
export type TeamMessageKind = 'chat' | 'task' | 'result' | 'handoff' | 'verdict' | 'notice'
export type TeamDelivery = 'accepted' | 'queued' | 'injected' | 'ignored' | 'superseded'
export type TeamTurnState = 'queued' | 'running' | 'completed' | 'interrupted' | 'failed'

export type TeamEventActor =
  | { type: 'human'; id: string; displayName?: string }
  | { type: 'role'; role: TeamRole; name: string }
  | { type: 'router'; name: 'ingress' | 'handoff' }
  | { type: 'system' }

export interface TeamEvent {
  id: string
  teamId: string
  seq: number
  kind: TeamEventKind
  createdAt: string
  actor: TeamEventActor
  content: string
  mentions: TeamRole[]
  replyTo?: string
  turnId?: string
  clientId?: string
  metadata: Record<string, unknown>
}

export interface TeamTurn {
  id: string
  teamId: string
  seq: number
  role: TeamRole
  triggerEventId: string
  state: TeamTurnState
  startedAt?: string
  endedAt?: string
  sessionId?: string
  outputEventId?: string
  abortReason?: 'human_interrupt' | 'team_stop' | 'timeout' | 'error'
  error?: string
  usage?: { input: number; cached: number; output: number }
}

export interface TeamThreadPage {
  teamId: string
  events: TeamEvent[]
  turns: TeamTurn[]
  nextAfter: number
  activity: TeamActivity
  waitingFor?: TeamWaitingFor
}

export type IngressAction = 'interrupt' | 'queue' | 'inject' | 'ignore'
export interface IngressDecision {
  action: IngressAction
  target?: TeamRole
  reason: string
  /** True when a deterministic rule decided; false when a fallback heuristic was used. */
  hardRule: boolean
}
export interface HandoffProposal {
  target: TeamRole
  task: string
  explicit: boolean
}
export interface HandoffDecision {
  target?: TeamRole
  task?: string
  reason: string
  accepted: boolean
}

/** Budgets for a bounded thread excerpt sent to a role or a router. */
export const THREAD_MAX_MESSAGES = 24
export const THREAD_MAX_CHARS = 16_000
export const THREAD_MESSAGE_MAX_CHARS = 2_000
export const DEFAULT_MAX_TURNS = 24
export const DEFAULT_MAX_HANDOFFS = 12
/** HTTP/UI limits, kept here so the host and panel describe the same bounds. */
export const HUMAN_MESSAGE_LIMIT = 20_000

/** Whether an unknown value is one of the fixed Team roles. */
export const isTeamRole = (value: unknown): value is TeamRole =>
  value === 'lead' || value === 'researcher' || value === 'developer' || value === 'tester' || value === 'reviewer' || value === 'ops'
