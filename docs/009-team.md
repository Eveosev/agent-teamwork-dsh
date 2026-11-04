# Agent Team

`/team` starts a six-role team for one task. It is a local-first orchestration mode: the Session that invokes `/team` creates a durable Team record, runs the roles as managed DSH subagents, and the panel shows each role's state, session and evidence. It does not need the GitHub or Feishu setup that Tickets need, so it also works while the Overview still reports a deployment problem.

## Use

In any DSH chat (the invoking Session becomes the team's parent):

```text
/team Add a health endpoint and a test for it
/team --open Add a health endpoint and a test for it        (open collaboration; see below)
/team --dir /Users/me/projects/agent-teamwork Add a health endpoint and a test for it
/team Fix the layout shown in the attached screenshot   (attach the image in the composer)
/team status
/team stop team-<id>
```

A Team starts in one of two modes. **Pipeline** keeps the fixed lead → researcher/developer → tester/reviewer → ops → lead sequence. **Open** keeps the same six roles but runs one active turn at a time and lets a role hand work to another role, the router gate each handoff, and a person message a running team. The panel's Team form defaults to **Open**; `POST /teams` defaults to **Pipeline** for compatibility, and `/team` accepts `--open`. The rest of this document describes the pipeline flow first, then the open additions.

The team works in the **Team working directory** from Execution settings, or `--dir <path>` for one run. The default is `<stateDir>/team`; set the setting to the target repository checkout (for example `/Users/me/Vibe/agent-teamwork`) before starting a team that should edit that repository.

The command does not create a Ticket and does not go through Eval or Policy: it is a direct human command. It is refused while processing is paused, and the number of concurrent teams is limited to the smaller of three and `executor.maxWorkers`. A team can also be started from the **Team** tab in the panel.

### Images

Attach one or more PNG/JPEG/WebP/GIF images to the composer before sending `/team ...`; DSH's attachment admission applies the format, size and count limits. An invocation with only images (no task text) also works: the task becomes `Work from the attached images.` and the title `Image task`.

- Every role receives the images after its task text, in submission order. The lead's two runs (plan and synthesis) receive them too, so the plan and final summary can use what the images show.
- The lead's model must declare `image` input. If the catalog explicitly says it does not, the command returns an error and no team is created. A role whose model explicitly rejects images is run with the task text plus a note instead of the image; it is not failed.
- Each role gets its own copy of the images, so visual token cost multiplies across the up-to-seven role calls. Attach only the images the task needs.
- Images live only in the run's prompts. The Team record stores text, not image bytes, so re-attach images when starting a new team.
- `status` and `stop` do not accept attachments, and file attachments are refused; both errors keep the composer draft.

The panel's Team form and `POST /teams` still accept text only; image input is currently a chat-composer feature.

## Roles and flow

| Role | Work | Example model route |
| --- | --- | --- |
| `lead` | Plans the work, then synthesizes the final summary | `deepseek-v4.1-flash-mb` |
| `researcher` | Reads the repository and external sources; returns facts and links | `glm-5.3-mb` |
| `developer` | Implements the task in the working directory | `glm-5.3-mb` |
| `tester` | Adds/adjusts tests, runs them, reports commands and results, and ends with a PASS/FAIL verdict | `deepseek-v4.1-flash-mb` |
| `reviewer` | Reviews the implementation, captures screenshot evidence for visually verifiable product/feature design, and ends with a PASS/FAIL verdict; read-only | `deepseek-v4.1-flash-mb` |
| `ops` | Inspects CI and deployment state; read-only | `glm-5.3-mb` |

The runtime runs: lead plan → researcher and developer in parallel → tester and reviewer in parallel → ops → lead synthesis. If both verifiers return `VERDICT: PASS`, the team finishes in one round. If either returns `VERDICT: FAIL`, the lead writes concrete repair instructions, the developer applies them, and the tester and reviewer run again. This repeats for at most `executor.maxRounds` rounds (default 3: one implementation plus two repairs); a team that still fails is marked `not_achieved`, so a person sees the unresolved result without having to drive each retry. Set the limit to 1–10 under **Execution settings → Max Team Rounds**; it is read when a run starts.

When the deliverable is a product or feature design that can be verified visually, the reviewer must capture a real screenshot of the implemented result and cite its path in the review. A code-only review is not visual acceptance; if a screenshot cannot be captured, the reviewer says why and marks that check unverified.

### Result and token usage

Every completed team has an `outcome`, separate from its execution `state`:

- `achieved`: both the tester and reviewer returned `VERDICT: PASS`.
- `not_achieved`: verification still failed after the round limit, or a verifier failed to run.
- `unverified`: a verdict was missing, so the team does not claim success. Older records without an outcome are shown as unverified.

Each member records `input`, `output` and `cached` token counts summed over every model call it made, including repeated repair rounds; the team total is the sum of its members. `input` is uncached input, and `cached` is cache-read input. The counts come from DSH's `assistant/message` usage events for the child Session.

The role's model, Agent preset and extra instructions come from the worker profile whose id equals the role name (`lead`, `researcher`, `developer`, `tester`, `reviewer`, `ops`). If that profile does not exist, the role uses `defaultProfile` or the executor model. See `docs/worker-profiles.md`.

## Evidence and lifecycle

A Team record holds the task, title, timestamps, parent Session, each member's profile, state, child Session id, output, error, verdict, round and token usage, plus the lead's final summary, outcome and round count. It is stored in the state directory and listed by the panel.

- `running` until the synthesis ends; then `done`.
- A member that fails records `failed` and its diagnostic; the team continues.
- `/team stop` or the panel's Stop aborts the team's signal and marks running members `stopped`.
- A process restart marks a still-running team `failed`; child subagents are not silently resumed.
- Outputs are clipped at 24,000 characters per member and summary.

## Open collaboration

Open mode keeps the fixed six-role roster: no role is invented at runtime. Each role still runs in a fresh child Session, but the Team thread is now the source of truth. The run starts with a lead plan, then a worker (normally the developer), the Tester and Reviewer gates, and a final lead synthesis. A role can skip the default next step with an explicit handoff line:

```text
HANDOFF: researcher | Check the authentication middleware and report the exact files
HANDOFF: developer | Implement the redirect fix in src/auth.ts
```

or the compact form `@researcher: Check ...`. The router checks that the target is a known role, rejects self-handoffs, deduplicates an identical handoff from the same turn, and enforces `maxHandoffs` (default 12). Explicit handoffs never bypass the Tester/Reviewer gate for `achieved`: the outcome is still `achieved` only when both verifiers return `VERDICT: PASS` and the lead synthesis completes.

A running Team has a **Team thread** in the detail page. The composer accepts a person message at any time:

- No mention follows the active turn; an `@role` mention targets that role.
- A redirect ("stop", "instead", "不要用", "改用", ...) interrupts the active turn, aborts its child Session, and starts a new turn with the message. The interrupted turn is recorded as `interrupted`, not failed.
- Other messages queue for the end of the current turn. An acknowledgement such as "ok" or "收到" is recorded but starts no new work.
- Messages are persisted in the thread; the panel polls `GET teams/:id/thread` while the team is open. The text limit is 20,000 characters, and a mention must name one of the six roles.
- After a terminal Team, use **Continue**; the thread and its history are kept.

Open turns have hard bounds: `maxTurns` (default 24) and `maxHandoffs` (default 12). Reaching either bound, or hitting a role failure, parks the Team as **waiting for you** rather than silently starting another turn; a stop is terminal.

### Approvals

A role can end its turn with `APPROVAL_REQUEST: <question>` when it needs a person to choose before a consequential action. The Team then has `waiting_for: "approval"`, and the thread shows **Approve** / **Reject** controls. The approval is a control-plane event, not a seventh worker: only a person resolves it. Approval returns the turn to the requesting role; rejection returns it to the lead with the person's reason. The API is `POST teams/:id/approvals/:eventId` with `{ approved, reason? }`.

Open mode does not yet make child Sessions persistent across turns, run turns concurrently, or enforce a tool-level approval gate. Those remain follow-ups in the design document; the current approval pauses between turns.

The team output is evidence for a person, not an automatic merge: review the summary, the child Sessions and the diff before shipping.

Team outputs keep Markdown image syntax. The panel renders images inline and turns relative or absolute local file links into a file dialog. `GET teams/:id/file?path=...` serves supported images and text only from the team's working directory; paths resolved outside it (including through symlinks) are refused. Images are capped at 8 MB.

## Team list filters

The Team tab filters the list into **To verify**, **Running**, **Close** and **ALL**. *Close* means a finished team whose outcome is `achieved`; *To verify* collects terminal teams that are not achieved (including legacy records without an outcome, `unverified`, `not_achieved`, failed and stopped teams); *Running* is the live state; *ALL* shows every record. The selected filter is kept in the panel route.

## Continuing a finished team

A terminal team (done, failed or stopped) has a **继续执行** / **Continue** entry in the panel list and detail page. It opens a dialog for an optional instruction and **continues the same Team record in place**, with the same id, task, title, working directory and card. No duplicate card is created.

The record keeps `continuations` and the prior attempt's `previous_summary`, `previous_outcome` and `previous_error`; `run_started_at` marks the current run and `continuation` / `continuation_recipients` describe the request. The same request is sent to all six roles; the lead and developer additionally receive the previous attempt's summary (or its latest role outputs when there is no summary), and every role is told that the working directory still contains the previous attempt. Verification, automatic repair, outcome and token accounting then run exactly as for a fresh team, and the latest summary and outcome replace the current ones after the run.

Each role activation is a separate child Session. `member.runs` keeps one entry per activation (`round`, `source`, `state`, `session_id`, timestamps), while `member.session_id` remains the latest activation for compatibility. The panel shows the latest prompt source and a collapsible run history with one Session button per round, so "Round 3" no longer implies that one Session contains every round. The source names the evidence quoted by the orchestrator (user task, lead plan, implementation, Tester/Reviewer verification, lead repair instructions, all role outputs, or a continuation); the orchestrator is always the actual sender.

Older continuation records created before in-place continuation retain their `continued_from` / `continued_from_title` audit link; the list shows only the latest card of such a lineage, and that card links back to the earlier records. The panel also has a compatibility path for a host that predates `POST teams/:id/continue`: it carries the source ID, task, evidence and request in the task of a normal new Team, titles it with a continuation marker, and reports the six recipients. Restarting the host enables in-place continuation and the persistent recipient section.

A terminal card also offers **删除** / **Delete**, which removes the Team card and its continuation lineage from the panel; the working directory and child Sessions are intentionally kept. A running Team must be stopped first.

Continuation requires the source to be terminal, processing to be unpaused, and an available team slot. The panel dialog can attach up to four screenshots (PNG, JPEG, WebP or GIF, 8 MB each); the Host admits them through `ctx.attachments` and sends them to every role after the text, exactly like a fresh `/team` image. Team records still store text only, so the attachments live in the role prompts rather than in the saved Team.

## API

The panel uses the same routes:

```text
GET  /orchestrator/api/teams                 -> { items: TeamSummary[], active: number }
GET  /orchestrator/api/teams/:id             -> Team
GET  /orchestrator/api/teams/:id/thread?after=&limit= -> { teamId, events, turns, nextAfter, activity, waitingFor? }
GET  /orchestrator/api/teams/:id/file?path=  -> { name, mime, data } (base64; only inside the Team directory)
POST /orchestrator/api/teams/:id/delete      -> { deleted: true } (terminal Team and its continuation lineage; files and Sessions are kept)
POST /orchestrator/api/teams                 { task, title?, directory?, mode?: 'open'|'pipeline' } -> { team }
POST /orchestrator/api/teams/:id/messages    { content, mentions?, clientId? } -> { event, delivery, target?, reason?, turnId? }
POST /orchestrator/api/teams/:id/approvals/:eventId { approved, reason? } -> { event, delivery, target?, reason? }
POST /orchestrator/api/teams/:id/continue    { instruction? } -> { team }
POST /orchestrator/api/teams/:id/stop        -> { stopped: boolean }
```

## Model route

The team uses DSH providers configured on the profile, not a separate gateway client. The example `examples/profile.agent-teamwork.cordis.patch.yml` declares `llm-center` (OpenAI-compatible) and `anthropic-gateway` (Anthropic Messages). DSH's Anthropic adapter sends `x-api-key`; the gateway also accepts `Authorization: Bearer $ANTHROPIC_AUTH_TOKEN` and both headers together (verified with `pnpm spike:gateway`), so either adapter style works. The exact model ids (`claude-opus-5-5`, `deepseek-v4.1-flash-mb`) must match what the provider exposes; drop a `[1m]` suffix if the provider does not list it.

## Limits

- No automatic PR or Ticket: the team runs in its own Team working directory (`--dir` or Execution settings), not a per-team worktree. Use the Ticket path when you need worktree isolation, CI checks, review gates and Feishu/GitHub replies.
- The worker preset gives every child the normal work tools. Role tool allowlists are enforced on Executor Sessions, not on team subagents; the team relies on role instructions plus the sandbox and the account. Do not give the team a more privileged account than the work needs.
- Open mode persists the thread, turns, handoffs and approvals; a child Session is still fresh per turn and is not resumed. Restart recovery marks a running open turn as failed rather than replaying it. Pipeline teams keep their original conservative recovery.
- Pipeline automatic repair is limited to `executor.maxRounds` (default 3); it does not wait for a person and does not merge or publish anything. Open mode uses `maxTurns` (24) and `maxHandoffs` (12) instead.
- Open mode serializes turns: one active turn at a time. It does not yet run roles concurrently or enforce a tool-level approval gate.
- Feishu and GitHub can trigger Tickets today; starting a team from an external trigger needs a bridge (for example a command handler or a future `team:` route), not part of v0.1.
