# Agent Team

`/team` starts a six-role team for one task. It is a local-first orchestration mode: the main Session creates a durable Team record, runs the roles as managed DSH subagents, and the panel shows each role's state, session and evidence.

## Use

In the DSH main Session:

```text
/team Add a health endpoint and a test for it
/team status
/team stop team-<id>
```

The command does not create a Ticket and does not go through Eval or Policy: it is a direct human command. It is refused while processing is paused, and at most three teams run at once. A team can also be started from the **Team** tab in the panel.

## Roles and flow

| Role | Work | Default model route |
| --- | --- | --- |
| `lead` | Plans the work, then synthesizes the final summary | `claude-opus-5-5` (planning, verification) |
| `researcher` | Reads the repository and external sources; returns facts and links | `deepseek-v4.1-flash-mb` |
| `developer` | Implements the task in the working directory | `deepseek-v4.1-flash-mb` |
| `tester` | Adds/adjusts tests, runs them, reports commands and results | `claude-opus-5-5` |
| `reviewer` | Reviews the implementation; read-only | `claude-opus-5-5` |
| `ops` | Inspects CI and deployment state; read-only | `deepseek-v4.1-flash-mb` |

The runtime runs: lead plan → researcher and developer in parallel → tester and reviewer in parallel → ops → lead synthesis. Each role except the lead is started once; the lead runs twice with the same profile. A member failure is recorded as evidence and does not cancel the other roles.

The role's model, Agent preset, tool allowlist and extra instructions come from the worker profile whose id equals the role name (`lead`, `researcher`, `developer`, `tester`, `reviewer`, `ops`). If that profile does not exist, the role uses `defaultProfile` or the executor model. See `docs/worker-profiles.md`.

## Evidence and lifecycle

A Team record holds the task, title, timestamps, parent Session, each member's profile, state, child Session id, output and error, plus the lead's final summary. It is stored in the state directory and listed by the panel.

- `running` until the synthesis ends; then `done`.
- A member that fails records `failed` and its diagnostic; the team continues.
- `/team stop` or the panel's Stop aborts the team's signal and marks running members `stopped`.
- A process restart marks a still-running team `failed`; child subagents are not silently resumed.
- Outputs are clipped at 24,000 characters per member and summary.

The team output is evidence for a person, not an automatic merge: review the summary, the child Sessions and the diff before shipping.

## API

The panel uses the same routes:

```text
GET  /api/teams                 -> { items: TeamSummary[], active: number }
GET  /api/teams/:id             -> Team
POST /api/teams                 { task, title? } -> { team }
POST /api/teams/:id/stop        -> { stopped: boolean }
```

## Model route

The team uses DSH providers configured on the profile, not a separate gateway client. The example `examples/profile.agent-teamwork.cordis.patch.yml` declares `llm-center` (OpenAI-compatible) and `anthropic-gateway` (Anthropic Messages). DSH's Anthropic adapter sends `x-api-key`; if `https://llm-center.modelbest.co` requires `Authorization: Bearer $ANTHROPIC_AUTH_TOKEN`, put a small proxy in front that adds that header, or route Claude through an OpenAI-compatible endpoint. The exact model ids (`claude-opus-5-5`, `deepseek-v4.1-flash-mb`) must match what the provider exposes; drop a `[1m]` suffix if the provider does not list it.

## Limits

- No automatic PR or Ticket: the team runs in the parent Session's working directory. Use the Ticket path when you need worktree isolation, CI checks, review gates and Feishu/GitHub replies.
- The worker preset gives every child the normal work tools. Role tool allowlists are enforced on Executor Sessions, not on team subagents; the team relies on role instructions plus the sandbox and the account. Do not give the team a more privileged account than the work needs.
- A team is not persisted as a resumable graph. Restart recovery is deliberately conservative.
- Feishu and GitHub can trigger Tickets today; starting a team from an external trigger needs a bridge (for example a command handler or a future `team:` route), not part of v0.1.
