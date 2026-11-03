# Agent Team

`/team` starts a six-role team for one task. It is a local-first orchestration mode: the Session that invokes `/team` creates a durable Team record, runs the roles as managed DSH subagents, and the panel shows each role's state, session and evidence. It does not need the GitHub or Feishu setup that Tickets need, so it also works while the Overview still reports a deployment problem.

## Use

In any DSH chat (the invoking Session becomes the team's parent):

```text
/team Add a health endpoint and a test for it
/team --dir /Users/me/projects/agent-teamwork Add a health endpoint and a test for it
/team Fix the layout shown in the attached screenshot   (attach the image in the composer)
/team status
/team stop team-<id>
```

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

The runtime runs: lead plan → researcher and developer in parallel → tester and reviewer in parallel → ops → lead synthesis. If both verifiers return `VERDICT: PASS`, the team finishes in one round. If either returns `VERDICT: FAIL`, the lead writes concrete repair instructions, the developer applies them, and the tester and reviewer run again. This repeats for at most three rounds (one implementation plus two repairs); a team that still fails is marked `not_achieved`, so a person sees the unresolved result without having to drive each retry.

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

The team output is evidence for a person, not an automatic merge: review the summary, the child Sessions and the diff before shipping.

## API

The panel uses the same routes:

```text
GET  /orchestrator/api/teams                 -> { items: TeamSummary[], active: number }
GET  /orchestrator/api/teams/:id             -> Team
POST /orchestrator/api/teams                 { task, title?, directory? } -> { team }
POST /orchestrator/api/teams/:id/stop        -> { stopped: boolean }
```

## Model route

The team uses DSH providers configured on the profile, not a separate gateway client. The example `examples/profile.agent-teamwork.cordis.patch.yml` declares `llm-center` (OpenAI-compatible) and `anthropic-gateway` (Anthropic Messages). DSH's Anthropic adapter sends `x-api-key`; the gateway also accepts `Authorization: Bearer $ANTHROPIC_AUTH_TOKEN` and both headers together (verified with `pnpm spike:gateway`), so either adapter style works. The exact model ids (`claude-opus-5-5`, `deepseek-v4.1-flash-mb`) must match what the provider exposes; drop a `[1m]` suffix if the provider does not list it.

## Limits

- No automatic PR or Ticket: the team runs in its own Team working directory (`--dir` or Execution settings), not a per-team worktree. Use the Ticket path when you need worktree isolation, CI checks, review gates and Feishu/GitHub replies.
- The worker preset gives every child the normal work tools. Role tool allowlists are enforced on Executor Sessions, not on team subagents; the team relies on role instructions plus the sandbox and the account. Do not give the team a more privileged account than the work needs.
- A team is not persisted as a resumable graph. Restart recovery is deliberately conservative.
- Automatic repair is limited to three rounds; it does not wait for a person and does not merge or publish anything.
- Feishu and GitHub can trigger Tickets today; starting a team from an external trigger needs a bridge (for example a command handler or a future `team:` route), not part of v0.1.
