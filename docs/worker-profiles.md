# Worker profiles

A worker profile names one kind of Executor Session: its model, an optional DSH Agent preset, the work tools it may use, and role instructions appended to the worker prompt. The Router chooses a profile when it accepts or routes a Ticket; the Executor stores the id on the Ticket's Execution metadata, and `Sessions.ensure` resolves it every time the Ticket runs.

Profiles are optional. With none configured, Tickets keep the previous behavior: the Executor model, the bundle's `dsh-superagent-worker` preset, and every work tool.

## Configure

Open the panel's **Execution settings** and edit **Worker profiles** as JSON, then choose a **Default profile**. The same block is available through `PUT /api/settings/executor`:

```json
{
  "maxWorkers": 3,
  "directory": "",
  "prepare": "",
  "blockedCommands": [],
  "model": null,
  "defaultProfile": "developer",
  "profiles": {
    "lead": {
      "label": "Team lead",
      "description": "Plans, splits work and reviews; does not edit.",
      "model": { "provider": "anthropic-gateway", "model": "claude-opus-5-5[1m]" },
      "tools": ["read", "glob", "grep", "web_search", "web_fetch", "todo_write"],
      "instructions": "You lead a small engineering team. Inspect the ticket, split it into independent workstreams, and delegate with subagent. Do not edit files yourself; review the team's evidence and report."
    },
    "researcher": {
      "label": "Researcher",
      "model": { "provider": "llm-center", "model": "deepseek-v4.1-flash-mb[1m]" },
      "tools": ["read", "glob", "grep", "web_search", "web_fetch"],
      "instructions": "Read the repository and external sources; return concise facts with file paths and links. Do not edit."
    },
    "developer": {
      "label": "Developer",
      "model": { "provider": "llm-center", "model": "deepseek-v4.1-flash-mb[1m]" },
      "instructions": "Implement the ticket in its worktree. Keep the change scoped, run the relevant checks, and report files, tests and risks."
    },
    "reviewer": {
      "label": "Reviewer",
      "model": { "provider": "anthropic-gateway", "model": "claude-opus-5-5[1m]" },
      "tools": ["read", "glob", "grep", "bash", "job_output", "job_list", "job_kill"],
      "instructions": "Review the diff against the ticket and the repository conventions. Run read-only checks; do not edit source files. For product/feature design that can be verified visually, capture a real screenshot and cite its path; if impossible, say why and mark the visual check unverified. Report findings by severity and the exact file/line."
    },
    "tester": {
      "label": "Tester",
      "model": { "provider": "anthropic-gateway", "model": "claude-opus-5-5[1m]" },
      "tools": ["read", "write", "edit", "glob", "grep", "bash", "job_output", "job_list", "job_kill", "todo_write"],
      "instructions": "Write and run tests for the ticket. Add only test files unless the assignment says otherwise; report the commands and their results."
    },
    "ops": {
      "label": "Ops",
      "model": { "provider": "llm-center", "model": "deepseek-v4.1-flash-mb[1m]" },
      "tools": ["read", "glob", "grep", "bash", "job_output", "job_list", "job_kill"],
      "instructions": "Inspect CI, logs and deployment state; run read-only commands. Do not edit the repository."
    }
  }
}
```

The built-in team instructions require the tester and reviewer to end with `VERDICT: PASS` or `VERDICT: FAIL`; a profile's `instructions` are appended, so they can add project-specific acceptance rules without removing that marker. The reviewer also has to capture a real screenshot when a product or feature design can be verified visually.

`tools` is an allowlist of the Executor's work tools (`read`, `write`, `edit`, `read_image`, `glob`, `grep`, `bash`, `pwsh`, `job_output`, `job_list`, `job_kill`, `web_search`, `web_fetch`, `skill`, `todo_write`, `subagent`, `list_subagent_models`, `send_message`, `list_agents`, `interrupt_agent`). Omit it for every work tool. The Executor still removes tools the Agent preset does not provide.

`preset` selects another DSH Agent preset for this profile. Leave it out to use the bundle's worker preset. A custom preset must provide the tools the profile names; the panel cannot create presets.

`model` is `{ provider, model, reasoningEffort? }`; `null` inherits the executor model. Provider ids are those configured on DSH's `llm-pi-ai` entry. The example uses `llm-center` (OpenAI-compatible) and `anthropic-gateway` (Anthropic Messages); see `examples/profile.agent-teamwork.cordis.patch.yml`.

## Behaviour

- The assessment payload lists `worker_profiles` and `default_profile`, and `orchestrator_eval_decide` / `orchestrator_route` accept `profile`.
- An unknown id is refused; the Executor never silently falls back from an explicitly named profile.
- A Ticket with no `profile` uses `defaultProfile`; with none, the executor model and the worker preset.
- The id is stored on `ticket.execution.profile`, shown on ticket cards and details, and survives restarts through the Store.
- Changing a profile affects new runs of its Tickets; an already-created Session keeps the model and preset it was created with, as with `executor.model`.
- Tool limits apply to the Executor Session and its spawned subagents; the prompt still tells the worker to stay within the Ticket scope.

## Apply the example

The example assumes the `llm-center` provider and its `deepseek-v4.1-flash-mb` and `glm-5.3-mb` models, which is how this checkout reaches the gateway. Replace the provider and model ids with the routes your DSH profile exposes. For a different provider per role, create that provider in the DSH Models page first; a profile whose provider is not registered fails at the first model call.

With the panel running, `pnpm seed:profiles` reads `examples/team-profiles.json`, takes the current executor block revision, and saves the six roles with `developer` as the default. Override `TEAMWORK_BASE_URL` (default `http://127.0.0.1:3092`) or `DEFAULT_PROFILE` when needed. The script prints the HTTP status and never reads a credential.

Check the gateway before starting a team: `ANTHROPIC_AUTH_TOKEN=... pnpm spike:gateway` reports whether the Anthropic route accepts `x-api-key`, `Authorization: Bearer`, or both.
