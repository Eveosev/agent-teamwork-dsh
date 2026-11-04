# Agent Team: Open Collaboration

**Status:** Draft design. This document describes a target architecture; it is not implemented yet.

**Scope:** Turn the six-role Agent Team from a fixed orchestration pipeline into an open, multi-agent, human-in-the-loop collaboration, while keeping an explicit control plane and hard safety bounds.

---

## 1. Why

The current Team is a workflow engine, not a collaboration space.

- The runtime owns the sequence: lead plan → researcher + developer → tester + reviewer → ops → lead synthesis.
- Roles cannot address each other. Cross-role information exists only as prompt text assembled by `teams.ts`.
- A role receives the task, the plan, the latest outputs and, for verifiers, accumulated verification history. It does not receive the team conversation.
- The runtime keeps only the latest output per role. Previous outputs are not available to later prompts.
- Every role activation starts a new child Session.
- A person can start a Team, stop it, and Continue it after it is terminal. There is no way to speak to a running Team.
- `maxRounds` is a hard runtime limit. It is not a collaboration budget.

That design is predictable and cheap, but it cannot support:

- a person correcting direction while Developer is working;
- Tester asking Developer a question instead of only emitting `VERDICT: FAIL`;
- Reviewer handing a concrete fix to Developer;
- Lead deciding at runtime that a researcher is needed again;
- a role proposing a different next step from the one the pipeline hard-codes.

OpenAgents' Workspace shows the alternative: a shared thread, addressed messages, a router that selects recipients, and a completion step that can hand work to another agent. The goal is to bring those properties to Team without giving up the parts that make Team useful: scoped work, a shared directory, auditable decisions and a verifier gate.

---

## 2. Goals and non-goals

### Goals

1. A durable, shared Team thread containing human messages, role messages, router decisions and system events.
2. A person can send a message while a Team is running, not only before or after it.
3. A human message is either injected immediately or queued at a turn boundary. The decision is explicit, explainable and auditable.
4. Roles can mention and hand off to other roles. Dispatch is gated by a router, so a role cannot create an unbounded ping-pong loop.
5. `lead` remains the default coordinator and fallback, but no longer owns a fixed sequence.
6. Tester and Reviewer verdicts remain a completion gate for `achieved`.
7. Hard bounds: total turns, handoffs, message sizes, transcript budget, queue depth.
8. The existing pipeline mode remains available and can be selected per Team.

### Non-goals for the first version

- Dynamically creating new roles or installing new agent types at runtime. The roster is still lead, researcher, developer, tester, reviewer, ops.
- Multiple turns executing concurrently in open mode. Open mode serializes turns in v1; parallel fan-out remains a pipeline-mode feature.
- Letting the router execute tools, edit files or approve risky actions.
- Automatically merging or shipping the result. A person still reviews the evidence.
- Replacing the existing Stop/Continue semantics for terminal Teams. New messages on a terminal Team are rejected and the UI offers Continue.
- Attachments in running messages. Text and mentions only in v1.

---

## 3. Terms

| Term | Meaning |
| --- | --- |
| Team thread | Append-only timeline of messages, turns, router decisions and approvals for one Team. |
| Message | A human, role, system or router entry in the thread. |
| Turn | One role activation, from assignment to result. At most one turn is active in open mode v1. |
| Handoff | A role's proposal that another role should receive a concrete next task. |
| Ingress | A human message arriving while the Team is running, queued or waiting. |
| IngressArbiter | Control-plane component that decides whether a human message interrupts, queues or is informational. |
| HandoffRouter | Control-plane component that validates and dispatches a role's proposed next step. |
| Active turn | The turn currently holding the Team's execution slot. |
| Waiting | No turn is active, but the Team is not terminal; it may be waiting for a human, an approval or a router decision. |
| Pipeline mode | The current fixed sequence, retained for compatibility and deterministic runs. |
| Open mode | Dynamic turn selection, shared thread, role mentions and human ingress. |

The two routers are **logical control-plane roles**, not members of the six-role roster. They have no worktree tools and never appear as worker cards. Their decisions appear in the thread as `router` events.

---

## 4. Target architecture

```text
                    ┌──────────────────────────────┐
                    │          Team thread         │
                    │  human / role / router /     │
                    │  system / approval events    │
                    └──────────────┬───────────────┘
                                   │
             human message         │        turn result
                    │              │              │
                    ▼              │              ▼
           ┌────────────────┐     │     ┌────────────────┐
           │ IngressArbiter │     │     │  HandoffRouter │
           │ interrupt?     │     │     │  who next?     │
           │ queue? inject? │     │     │  accept? stop? │
           └───────┬────────┘     │     └───────┬────────┘
                   │              │             │
                   └──────────────┼─────────────┘
                                  ▼
                         ┌────────────────┐
                         │   TurnRunner   │
                         │ one role turn  │
                         │ abortable      │
                         └───────┬────────┘
                                 │
                                 ▼
                         ┌────────────────┐
                         │  child Session │
                         │  role prompt   │
                         └────────────────┘
```

The Team thread is the source of truth. A child Session is an execution detail, not the team's memory. A role that needs context receives a bounded thread excerpt plus its current assignment; it does not rely on having been present for every previous turn.

### 4.1 Modes

A Team is created with a mode:

```text
open       dynamic turns, role mentions, human ingress; the target mode
pipeline   current six-role sequence; no open handoffs
```

`open` is the target default after rollout. `pipeline` remains for compatibility, reproducibility and debugging. The mode is stored on the Team record so an old Team keeps its behavior.

`maxRounds` remains a pipeline-mode budget. Open mode uses `maxTurns` and `maxHandoffs` instead.

### 4.2 Coordination and openness

Open mode means:

- every role may post a message and mention another role;
- a role may propose a handoff;
- a person may address any role directly;
- the Lead is the default coordinator and fallback recipient, not a fixed stage.

It does **not** mean every mention is dispatched immediately. The HandoffRouter is the gate:

```text
role output
  → explicit HANDOFF / @role?
  → validate target, task, duplicates, limits
  → dispatch, ask the Lead, or wait
```

This is the "open conversation, controlled dispatch" compromise selected for Team: roles can talk to each other, but a control-plane router decides whether a proposal becomes a run.

### 4.3 One active turn

Open mode v1 runs one turn at a time.

Reasons:

- a human interrupt has exactly one target;
- the thread order is unambiguous;
- a role cannot observe a half-written result from a concurrent role;
- deduplication and loop detection are tractable.

Parallel role execution remains available in pipeline mode. Concurrent turns in open mode are a later optimization, not a v1 requirement.

### 4.4 What the Lead is for

`lead` has three jobs in open mode:

1. **Planner:** produce the initial plan and constraints.
2. **Coordinator fallback:** receive messages that have no explicit target, and decide the next step when no role proposed one.
3. **Synthesizer:** produce the final summary when the work is complete.

The Lead is not privileged to ignore the verifier gate. It cannot turn a failing Team into `achieved`.

---

## 5. Data model

### 5.1 Thread events

The thread is append-only. Every item has a team-local sequence number so clients can page deterministically.

```ts
type TeamEventKind =
  | 'message'          // human or role content
  | 'turn'             // turn lifecycle
  | 'router'           // ingress or handoff decision
  | 'approval'         // approval request/resolution
  | 'system'           // runtime notices

type TeamEvent = {
  id: string                 // UUID
  teamId: string
  seq: number                // monotonic per team
  kind: TeamEventKind
  createdAt: string          // ISO timestamp
  actor:
    | { type: 'human'; id: string; displayName?: string }
    | { type: 'role'; role: TeamRole; name: string }
    | { type: 'router'; name: 'ingress' | 'handoff' }
    | { type: 'system' }
  content: string            // bounded, UTF-8
  mentions: TeamRole[]       // validated roster names only
  replyTo?: string           // event id
  turnId?: string
  clientId?: string          // human idempotency key
  metadata: Record<string, unknown>
}
```

Message metadata should carry, at minimum:

```json
{
  "messageKind": "chat | task | result | handoff | verdict | notice",
  "delivery": "accepted | queued | injected | ignored | superseded",
  "targets": ["developer"],
  "reason": "short human-readable explanation",
  "format": "text/markdown"
}
```

Do not store hidden chain-of-thought. Store the visible output, the protocol line and the router's short reason.

### 5.2 Turn record

```ts
type TeamTurn = {
  id: string
  teamId: string
  seq: number
  role: TeamRole
  triggerEventId: string
  state: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed'
  startedAt?: string
  endedAt?: string
  sessionId?: string
  outputEventId?: string
  abortReason?: 'human_interrupt' | 'team_stop' | 'timeout' | 'error'
  error?: string
  usage?: { input: number; cached: number; output: number }
}
```

A turn is the unit of execution and accounting. It is not the same as a Team "round" in pipeline mode.

### 5.3 Team record additions

```ts
type Team = {
  // existing fields...
  mode: 'open' | 'pipeline'
  activity: 'active' | 'waiting' | 'terminal'
  activeTurnId?: string
  waitingFor?: 'human' | 'approval' | 'router' | 'none'
  maxTurns: number
  maxHandoffs: number
  handoffCount: number
  turnCount: number
}
```

Keep the existing `state` (`running | done | failed | stopped`) so list filters and terminal semantics do not change. `activity` distinguishes "a turn is running" from "the Team is alive but waiting for a person".

### 5.4 SQLite tables

A new schema version (12) adds:

```sql
CREATE TABLE team_event (
  team_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  actor_type  TEXT NOT NULL,
  actor_role  TEXT,
  content     TEXT NOT NULL,
  mentions    TEXT NOT NULL DEFAULT '[]',
  reply_to    TEXT,
  turn_id     TEXT,
  client_id   TEXT,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (team_id, seq),
  UNIQUE (team_id, id)
);

CREATE INDEX team_event_created ON team_event(team_id, created_at);

CREATE UNIQUE INDEX team_event_client
  ON team_event(team_id, client_id)
  WHERE client_id IS NOT NULL;

CREATE TABLE team_turn (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  role          TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  state         TEXT NOT NULL,
  session_id    TEXT,
  output_event  TEXT,
  abort_reason  TEXT,
  error         TEXT,
  usage         TEXT,
  started_at    TEXT,
  ended_at      TEXT,
  UNIQUE (team_id, seq)
);

CREATE INDEX team_turn_active ON team_turn(team_id, state);
```

`seq` is allocated inside the same transaction that appends the event or creates the turn. `client_id` makes human message submission idempotent across retries.

The existing Team record remains the list/detail aggregate. The thread is not embedded in it, so a long conversation cannot inflate the record used by list views.

### 5.5 Legacy Teams

Teams created before this feature have no thread rows. On first open:

- synthesize one `task` message from the existing task;
- synthesize one `result` message from the final summary, if present;
- do not fabricate a conversation that never happened.

Legacy Teams stay `pipeline` mode.

---

## 6. State machines

### 6.1 Team activity

```text
                 ┌────────────┐
   create ──────▶│   active   │
                 └─────┬──────┘
          turn done    │    no next step / human needed
                       ▼
                 ┌────────────┐
                 │  waiting   │◀──── approval requested
                 └─────┬──────┘
       human message   │    stop / done / fail
                       ▼
                 ┌────────────┐
                 │  terminal  │
                 └────────────┘
```

`state` remains the existing terminal contract. `activity` is a live control-plane view; it is not used to filter terminal Teams.

### 6.2 Turn

```text
queued ──▶ running ──▶ completed
                ├────▶ interrupted
                └────▶ failed
```

Rules:

- Only one turn may be `running` per Team in open mode.
- `completed` means the role returned; it does not mean the Team is done.
- `interrupted` means the child Session was aborted by a human or a stop. Partial output may be retained as diagnostic text, but it is never treated as a completed result.
- `failed` means the role or transport failed; the Team may continue if the router has a fallback.

### 6.3 Human message delivery

```text
accepted ──▶ queued ──▶ injected
     │           │
     │           └────▶ superseded
     └──────────▶ ignored (informational; still visible)
```

- `accepted`: written to the thread; no decision yet.
- `queued`: will be considered at the next turn boundary.
- `injected`: selected as the trigger for a new or interrupted turn.
- `ignored`: recorded and visible, but starts no work (for example a bare acknowledgement).
- `superseded`: a newer human message made this one obsolete before it ran.

The message is always visible immediately, even when queued. The UI must not imply it has been delivered to a model.

---

## 7. Routing

### 7.1 Human ingress: hard rules first

Do not ask a model to classify every message. Apply these rules before any model call:

| Condition | Action | Target |
| --- | --- | --- |
| Team is terminal | Reject with 409; UI offers Continue | — |
| Message is an approval/rejection and an approval is pending | Inject immediately | Current role / Lead |
| No turn is active, no approval pending | Inject immediately | Explicit mention, or Lead |
| Explicit stop/abort language | Interrupt current turn, then inject | Current role, or Lead |
| Explicit `@role` plus a concrete new task | Queue at turn boundary, unless the message says to abandon current work | Mentioned role |
| Reply to a role's pending question | Inject immediately | Asking role |
| Informational acknowledgement with no request | Record, do not dispatch | — |
| Anything ambiguous | `IngressArbiter` model call | Model-selected |

Stop/abort language is a deterministic list, not a model judgment. It should include at least the equivalents of "stop", "cancel", "abort", "do not continue", "stop the current task", and the same intent in the user's language.

Do not interrupt for a message that merely adds context. Do not queue a message that answers a role that is blocked waiting for it.

### 7.2 IngressArbiter

The IngressArbiter is only called for the ambiguous cases left by the hard rules. It classifies; it does not execute, edit, approve or talk to the role.

Inputs, all bounded:

```text
new human message
mission / original task
active turn: role, phase, elapsed, current tool or wait state
latest visible output tail
last 12 thread messages (content clipped)
pending approval or pending question
queued human messages
roster and current role status
```

Output:

```json
{
  "action": "interrupt | queue | inject | ignore",
  "target_role": "developer | null",
  "reason": "short explanation",
  "instruction": "optional restatement of the actionable request"
}
```

Policy:

- Prefer `queue` when the message adds constraints, asks a follow-up, or arrives near the end of a turn.
- Prefer `interrupt` only when the current work is clearly invalidated, or the person explicitly redirects it.
- Prefer `inject` when the Team is idle or the current role is blocked on the person.
- Never let the model choose a role outside the roster.
- Never let the model turn an approval into an automatic authorization.
- On timeout, parse failure or provider error: `queue` (or `inject` if idle). Never default to interrupt.
- Record `action`, `reason`, `model`, `latency` and whether a hard rule or the model decided.

The IngressArbiter's reason is shown in the thread. It is not hidden.

### 7.3 HandoffRouter

The HandoffRouter runs after a turn completes, and only after any queued human message has been considered. Human input always wins over a role's proposed next step.

Resolution order:

1. **Explicit protocol in the role output**
   - `HANDOFF: <role> | <task>`
   - or a top-level `@<role>` with a concrete task.
   - Parse only a line or a clearly delimited block; ignore examples inside code fences or quoted instructions.
2. **Verifier outcome**
   - Tester and Reviewer each end with `VERDICT: PASS` or `VERDICT: FAIL`.
   - Both PASS → Lead synthesis.
   - Any FAIL → Developer with the concrete failure, or Lead if the repair needs replanning.
   - Missing verdict → `unverified`, do not claim success.
3. **Lead decision**
   - If no explicit handoff and no verifier gate, send the result to Lead for a decision.
   - Lead may handoff, request a human decision, or declare done.
4. **Wait**
   - If Lead has no concrete next step, set `waitingFor = human` rather than inventing work.

Validation:

- Target must be a known role and not the sender.
- Target must be allowed by the Team's mode and permissions.
- Task must be concrete; empty or purely social mentions are ignored.
- Duplicate handoffs for the same `(source turn, target, task hash)` are dropped.
- The same target cannot receive the same task twice.
- `maxTurns` and `maxHandoffs` are checked before dispatch.
- A verifier cannot be bypassed by a role saying "done".
- The router cannot dispatch when the Team is stopped, terminal or waiting for an approval that has not been resolved.

If validation fails, the router writes a `router` event with a reason and falls back to Lead or waiting. It must not silently drop the result.

### 7.4 Loop control

Open collaboration needs explicit loop control, not just a friendly prompt:

- one active turn;
- no self-handoff;
- duplicate task detection;
- `maxHandoffs` per Team (default 12, configurable 1–50);
- `maxTurns` per Team (default 24, configurable 1–100);
- a turn that produces no new artifact and no verdict cannot immediately hand back to its sender;
- a human message resets the "waiting" state but does not reset the counters.

When a limit is reached, the Team enters `waitingFor = human` and the UI says which limit was reached. It does not silently mark the task achieved.

---

## 8. Turn execution

### 8.1 Context assembly

A role prompt is built from:

1. role instructions and profile;
2. the mission and current constraints;
3. the current assignment (the triggering human or handoff message);
4. a bounded thread excerpt;
5. the current verifier state, if the role is a verifier;
6. the response protocol.

Thread excerpt budget for v1:

```text
THREAD_MAX_MESSAGES       24
THREAD_MAX_CHARS          16_000
THREAD_MESSAGE_MAX_CHARS   2_000
```

Selection rules:

- always include the current assignment and the latest human message;
- include the most recent messages first, then backfill until the budget is reached;
- never split a message mid-code-block if avoidable;
- label every item with its sender and timestamp;
- wrap the excerpt as conversation data, not as system instructions;
- keep the mission outside the excerpt budget.

The full thread remains in storage. The prompt gets an excerpt, not the whole history.

### 8.2 Progress snapshot

The IngressArbiter needs to know what the current turn is doing. Build a small, bounded snapshot rather than exposing the whole Session:

```ts
type TurnProgress = {
  turnId: string
  role: TeamRole
  startedAt: string
  phase: 'starting' | 'model' | 'tool' | 'waiting' | 'finishing' | 'unknown'
  lastEventAt?: string
  lastVisibleOutputTail?: string   // max 500 chars; never hidden reasoning
  pendingTool?: string             // name only, no arguments or output
  blockedOn?: 'human' | 'approval' | 'tool'
}
```

The snapshot is derived from the child Session's visible lifecycle events where DSH exposes them. If the runtime cannot observe fine-grained progress, use `phase = 'unknown'`, `startedAt` and the latest persisted output; do not invent tool state.

The snapshot is kept in memory and written to the router decision event. It is not a per-token log and it must not include chain-of-thought, file contents or tool arguments.

When progress is `unknown`, the IngressArbiter must be conservative: explicit stop/redirect still takes the hard-rule path, but ambiguous messages default to `queue`.

### 8.3 Response protocol

Every role is asked to end with one of:

```text
HANDOFF: <role> | <concrete task>
DONE: <short result>
```

Tester and Reviewer additionally end with:

```text
VERDICT: PASS
```

or

```text
VERDICT: FAIL
```

A role may also emit:

```text
APPROVAL_REQUEST: <what the person must approve>
```

The parser is tolerant of surrounding prose but strict about the protocol fields. A protocol line inside a fenced code block or an example is not a handoff. Invalid targets are rejected and audited.

### 8.4 Sessions

v1 keeps the current execution model: each turn is a fresh child Session, and continuity comes from the thread excerpt. This avoids relying on hidden per-role session memory and makes replay/audit simpler.

Persistent per-role Sessions are a later option. If added, the thread remains authoritative; a persistent Session must not become a second, invisible source of truth.

### 8.5 Abort

Each turn owns an `AbortController`. An interrupt:

1. marks the turn `interrupted`;
2. aborts the child Session;
3. preserves partial output as diagnostic text, never as a completed result;
4. records `abortReason`;
5. appends the human message as `injected`;
6. lets the IngressArbiter select the next target.

If the turn completes before the abort lands, the completion wins: the message is queued instead of injected. The runtime must not mark a completed turn as interrupted after its result has been persisted.

---

## 9. Human-in-the-loop behavior

### 9.1 Sending while running

The Team detail page always exposes the composer while the Team is active or waiting. Sending:

- writes the message to the thread immediately;
- returns an accepted message plus a provisional delivery state;
- lets the IngressArbiter update the state asynchronously;
- never blocks on the current turn finishing.

The UI shows one of:

- `Queued — will be considered after the current Developer turn`
- `Injected — current turn interrupted`
- `Delivered — waiting for Tester`
- `Recorded — no action needed`

### 9.2 Waiting states

The Team becomes `waitingFor = human` when:

- the router has no concrete next step;
- a role asks for missing information;
- an approval is pending;
- a hard limit is reached.

In this state, a human message injects immediately (subject to approval rules) and resumes the Team. The UI shows a prominent "Waiting for you" badge rather than a spinner.

### 9.3 Approvals

An approval is a first-class event, not a normal handoff. When a role emits `APPROVAL_REQUEST`:

- no new turn starts;
- `waitingFor = approval`;
- the UI shows the request and Approve/Reject actions;
- only a human can resolve it;
- the router cannot approve;
- approval does not grant new filesystem or tool permissions beyond what the Team already has.

Approvals are phase 3 in the rollout, but the data model reserves the event kind now.

### 9.4 Terminal Teams

`POST /teams/:id/messages` on a terminal Team returns `409` with a machine-readable `terminal` reason.

The UI offers **Continue and send**, which calls the existing Continue path with the text as the continuation instruction. This keeps the current invariant that a completed Team is not silently reopened by a stray message.

### 9.5 Stop

Stop remains a Team-level operation:

- aborts the active turn;
- marks it `stopped`/`interrupted`;
- cancels queued messages or marks them `superseded`;
- moves the Team to `stopped`.

A human "stop" message is equivalent to the explicit Stop action.

---

## 10. API

All routes use the existing panel/session authentication.

### Read the thread

```http
GET /teams/:id/thread?after=<seq>&limit=100
```

Response:

```json
{
  "teamId": "team-...",
  "events": [],
  "turns": [],
  "nextAfter": 42,
  "activity": "active",
  "waitingFor": null
}
```

`after` is exclusive. The UI polls while active and backs off when terminal. SSE can replace polling later without changing the shape.

### Send a human message

```http
POST /teams/:id/messages
Content-Type: application/json

{
  "content": "Use the existing auth middleware; do not add a new one.",
  "mentions": ["developer"],
  "clientId": "b1d4..."
}
```

`clientId` is required for idempotency and generated by the client per composition.

Response `202`:

```json
{
  "event": {},
  "delivery": "queued | injected | ignored",
  "target": "developer",
  "turnId": null,
  "reason": "current turn is still running"
}
```

The final delivery may be refined asynchronously if the initial decision was made before the active turn changed state.

### Interrupt explicitly

```http
POST /teams/:id/turns/:turnId/interrupt
Content-Type: application/json

{ "reason": "human requested redirect" }
```

This is a human override. It is not required for normal ingress; the IngressArbiter normally decides. The UI uses it for the "Interrupt now" action on a queued message.

### Existing routes

- `POST /teams/:id/stop` remains the Team-level stop.
- `POST /teams/:id/continue` remains the terminal continuation path.
- `GET /teams/:id` remains the aggregate/list view.
- `DELETE /teams/:id` deletes the team and its thread/turn rows in the same transaction.

### Limits

- Human message: 20,000 characters.
- Mentions: at most 6, roster-only.
- Queue depth: 50 accepted but undelivered human messages; beyond that return `429`.
- Thread page: at most 200 events.

---

## 11. UI

### 11.1 Team detail

Replace the current "rounds + cards" detail with a two-pane layout:

```text
┌───────────────────────────────┬──────────────────────┐
│ Team thread                   │ Roles / runs         │
│                               │                      │
│ [human] ...                   │ Lead      idle       │
│ [lead] ...                    │ Developer running    │
│ [router] handed to Tester     │ Tester    queued     │
│ [tester] ...                  │ Reviewer  idle       │
│                               │ Ops       idle       │
│ ┌───────────────────────────┐ │                      │
│ │ Message the team...  @    │ │ Tokens / outcome     │
│ └───────────────────────────┘ │                      │
└───────────────────────────────┴──────────────────────┘
```

- Role messages use role colors and a role badge.
- Human messages are visually distinct and always first-class.
- Router decisions are compact system notices; expanding shows reason and targets.
- Turn messages show session link and token usage.
- Verdict messages are highlighted.
- A queued human message shows its delivery state inline.
- The composer is available while `active` and `waiting`; it is replaced by Continue on terminal.
- `@` opens a roster picker; free text is still allowed.
- A "Stop team" action remains in the header.

### 11.2 Activity

Header badge:

```text
Running — Developer, 02:14
Waiting for you — approval required
Waiting — no next step
```

Do not show an indefinite spinner when the Team is waiting.

### 11.3 Queue and interrupt feedback

A small banner above the composer:

```text
1 message queued — will apply after the current turn
[Interrupt now]
```

When an interrupt lands:

```text
Current Developer turn interrupted. Handing the request to Lead...
```

The banner is a status, not a modal. The human should never have to guess whether a message was received.

### 11.4 History

The current per-round run history remains available in the Roles pane. A turn links to its child Session. Thread events and turn records share timestamps so a person can correlate a role's message with the session that produced it.

---

## 12. Safety, cost and permissions

### 12.1 Prompt injection

- Human and role messages are data. They are wrapped and labeled, not inserted as system instructions.
- A role's output cannot modify another role's system prompt.
- A protocol line inside a code block is not a handoff.
- The router prompt treats the thread as untrusted conversation data and does not follow instructions embedded in it.
- The parser validates targets against the fixed roster.

### 12.2 Permission boundary

- The router cannot edit files, run commands, approve actions or grant permissions.
- The router cannot add a role to the Team.
- The router cannot access paths outside the Team working directory.
- Approvals are human-only.
- A human message cannot silently elevate a role's tool profile.

### 12.3 Cost

- One active turn bounds concurrent model spend.
- Thread excerpts are bounded; the full thread is never sent.
- Router calls are small and only on ambiguous decisions.
- Every turn records input, cached and output tokens.
- `maxTurns` and `maxHandoffs` are the cost ceiling.
- The UI shows a running token total and the configured limits.

### 12.4 Availability

- If the IngressArbiter model is unavailable, default to queue; if the Team is idle, inject.
- If the HandoffRouter model is unavailable, use explicit protocol and verifier rules; otherwise wait for a human.
- If the thread store write fails, the message send fails visibly; do not pretend it was queued.
- If the process restarts, running turns become `failed`; the thread is intact. The Team remains resumable via Continue, not silently.

---

## 13. Failure and race handling

| Scenario | Required behavior |
| --- | --- |
| Human message races with turn completion | Persist the completion first; then decide. If the turn is completed, queue. Never rewrite a completed turn as interrupted. |
| Two human messages arrive together | Both are persisted. The newer one may mark the older `superseded` if it clearly replaces it; otherwise process FIFO. |
| Duplicate client retry | `client_id` unique index returns the original event; no duplicate turn. |
| Interrupt requested twice | First abort wins; second is a no-op recorded as a router notice. |
| Role proposes an invalid target | Reject, record reason, fall back to Lead or wait. |
| Role handoffs to itself | Reject. |
| Role loops A → B → A with the same task | Duplicate task hash rejection. |
| Verifier missing verdict | Team outcome `unverified`; no success claim. |
| Human approval after turn timeout | Inject immediately; the approval is the new trigger. |
| Store transaction fails mid-append | No partial event; the caller sees an error. |
| Team stopped during ingress decision | Decision is discarded; message remains visible as `superseded` or `ignored`; no new turn. |
| Process restart during a turn | Turn marked `failed`; Team terminal `failed` unless a human Continue is used. |

The central rule: **completion and interruption are mutually exclusive, and the persisted turn state is the arbiter.**

---

## 14. Migration and compatibility

1. Add schema version 12 with `team_event` and `team_turn`.
2. Add `mode`, `activity`, `waitingFor`, `maxTurns`, `maxHandoffs`, `handoffCount`, `turnCount`, `activeTurnId` to Team records with defaults.
3. Existing Teams default to `mode = pipeline`, `activity = terminal` or `active` based on state, `maxTurns = 24`, `maxHandoffs = 12`.
4. Legacy thread lazily seeds task and result events on first read.
5. Keep `maxRounds` behavior for pipeline Teams.
6. Keep `POST /continue` and `/stop` unchanged for clients that do not know about the thread.
7. The panel can render a Team with no thread as a legacy view; do not block the list on a thread query.

Rollback: if the feature flag is disabled, the runtime ignores `team_event` and uses the current pipeline. No destructive migration is required; the new tables can remain.

---

## 15. Observability

Record per Team:

- turns started/completed/interrupted/failed;
- handoffs proposed/accepted/rejected;
- duplicate handoffs rejected;
- ingress decisions by action and by hard-rule vs model;
- queue latency (message accepted → injected);
- interrupt latency (request → child Session aborted);
- waiting time by reason;
- token usage per turn and total;
- limits reached.

Thread UI is the primary audit surface. Logs must not dump full prompts or message bodies by default; record ids, roles, decisions and sizes.

---

## 16. Testing

### Unit

- Ingress hard rules, including stop phrases in English and Chinese.
- Ingress output validation: unknown role, invalid action, missing reason.
- Handoff parser: valid line, code-fence example, quoted text, invalid role, self-target.
- Duplicate task hashing.
- Verifier gate: PASS/PASS, PASS/FAIL, missing verdict.
- Context excerpt: budget, ordering, current assignment always included.
- Limit enforcement.

### Integration

1. Human sends a constraint while Developer is running → queued; Developer completes; constraint is included in the next turn.
2. Human says "stop, use the existing middleware" → current turn interrupted; Developer receives the new instruction; no duplicate work.
3. Human answers Tester's question while Tester is waiting → injected immediately.
4. Human `@reviewer` while idle → Reviewer turn starts.
5. Developer emits `HANDOFF: tester | ...` → Tester runs once; duplicate handoff is dropped.
6. Tester FAIL → Developer repair → Tester PASS → Lead synthesis.
7. A → B → A loop with the same task is blocked.
8. `maxTurns` reached → waiting for human, not achieved.
9. Two messages race with completion → one completion, one queued message, no interrupted completed turn.
10. Process restart → thread intact, turn failed, Continue works.
11. Terminal Team message → 409; Continue and send works.

### UI

- Composer enabled while running.
- Queued/injected status updates.
- Interrupt banner and "Interrupt now".
- `@` picker only offers roster roles.
- Waiting badge instead of spinner.
- Router decision expandable.
- Legacy Team renders without thread.

### Regression

- Pipeline mode produces the same sequence and verdict behavior as today.
- Existing Team list filters and Continue/Stop/Delete still pass.
- Token accounting still matches child Session usage.

---

## 17. Rollout

### Phase 0 — design

This document. No code changes.

### Phase 1 — shared thread and human ingress

- schema and thread API;
- Team detail thread UI and composer;
- hard-rule ingress and queue/inject;
- IngressArbiter for ambiguous cases;
- no role-to-role handoff yet;
- mode remains `pipeline` unless explicitly opted in.

Exit criteria: a person can add a constraint or correction while a Team runs, see whether it was queued or injected, and the Team respects it at the next turn.

### Phase 2 — open handoff

- `HANDOFF` / `@` parsing;
- HandoffRouter;
- open mode;
- maxTurns / maxHandoffs;
- role messages and router notices in the thread.

Exit criteria: a Team can complete a task without the fixed sequence, while verifier gates and limits still hold.

### Phase 3 — approvals and richer collaboration

- approval events and waiting UI;
- optional persistent per-role Sessions;
- concurrent turns, if justified;
- attachments in running messages;
- human acceptance separate from verifier outcome.

### Default mode

Ship open mode behind a setting. After Phase 2 has passed the regression suite and real use, make `open` the default for new Teams and keep `pipeline` as an explicit choice. Existing Teams do not change mode.

---

## 18. Open questions

1. **Visible router?** Recommendation: keep IngressArbiter and HandoffRouter as internal control-plane roles; show their decisions as `router` events, not as worker cards. A visible seventh role would confuse the roster and add a Session without adding work.
2. **Persistent role Sessions?** Recommendation: no in v1. The thread is the memory; fresh turns are simpler to replay. Revisit if roles repeatedly need continuity that the excerpt cannot provide.
3. **Parallel open turns?** Recommendation: no in v1. Serialize; keep parallel fan-out in pipeline mode.
4. **Human acceptance vs verdict?** Recommendation: keep the verifier gate for `achieved`. A human can stop or Continue, but cannot turn a FAIL into `achieved` in v1. A separate `accepted_by_human` outcome can be designed later.
5. **Attachments?** Text only in v1. Images and files need their own admission, size and path rules.
6. **Dynamic roles?** Out of scope. Open communication does not imply dynamic membership.
7. **Default `maxTurns` / `maxHandoffs`?** Proposed 24 / 12. Tune after real runs; both must be visible in the UI, like `maxRounds` today.
8. **Do queued messages survive a restart?** Proposed: yes, as thread events; the Team is terminal `failed`, so they are visible but not auto-delivered until Continue.

---

## 19. Acceptance criteria

The design is successful when all of the following are true:

- A running Team has a durable thread that a person can read.
- A person can send a message while a role is running and sees whether it was queued or injected.
- An explicit stop/redirect can interrupt the active turn; a completed turn is never rewritten as interrupted.
- A role can hand off to another role with a concrete task, and the router can reject invalid, duplicate or looping handoffs.
- A Team can run in open mode without the fixed six-stage sequence.
- Tester/Reviewer PASS is still required for `achieved`; missing verdicts remain `unverified`.
- `maxTurns` and `maxHandoffs` stop runaway collaboration and leave the Team waiting for a human.
- Pipeline mode still behaves as it does today.
- Every router decision is visible and auditable, with a short reason.
- No new filesystem, approval or role-creation permission is granted by the router or by a human message.

---

## 20. Summary

Team should become an open collaboration, but "open" must mean **open communication with controlled dispatch**, not unbounded agent chatter.

The minimum viable shape is:

```text
shared thread
  + human ingress with interrupt/queue arbitration
  + addressable role handoffs
  + verifier gate
  + hard turn/handoff limits
```

The IngressArbiter and HandoffRouter are separate control-plane decisions. They may share a model, but not a prompt or a decision. Neither is a seventh worker role. The thread is the source of truth; child Sessions are execution details.
