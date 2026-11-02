# GitHub, CI and Feishu

The product has three edges into the team: a GitHub Source (issues, pull requests and CI), a Feishu Source, and the local Agent Team. They share one settings store and one panel.

## GitHub and CI

1. In the target repository (`Eveosev/agent-teamwork`), confirm the CI workflow is green: `.github/workflows/ci.yml` runs install, typecheck and tests on push and pull request.
2. Prepare a GitHub CLI identity for the agent (a bot account or a fine-grained token in `gh`), with push access to the target repository. Do not put the token in this repository.
3. In the panel's **Sources → GitHub**, set the repository (`Eveosev/agent-teamwork`) and the CLI name. The setup check verifies the login, the repository and push permission.
4. Open an issue from the target repository's starter list (or a new issue) and mention the configured account. The Router assesses it, creates a Ticket with a worktree, the Executor implements it, CI runs, and the worker can open a pull request.
5. With `observeCi`, CI changes on a followed pull request become Triggers; a failure resumes the same Ticket with the CI evidence. With `merge` rules, a green PR can be merged by the configured account.

A minimal Source configuration (the exact block shape follows the panel's Source block):

```json
{
  "enabled": true,
  "config": { "repository": "Eveosev/agent-teamwork", "cli": "gh-agent", "pollSeconds": 120 }
}
```

The product does not store a GitHub token: `gh` owns its credential, and the setup check only reads the login.

## Feishu (placeholder)

Feishu is optional and stays disabled until the bot IDs exist:

```yaml
# examples/feishu.placeholder.yml
enabled: false
config:
  cli: ''
  chats: []
  directMessages: true
# Fill these from the Feishu developer console and the chat list when ready:
# appId: <app id>
# chatId: <oc_...>
# allowedOpenIds: [<ou_...>]
```

`GET /open-apis/im/v1/chats` returns chat ids; an event payload carries the sender's open id. Until then the panel shows the Source as not configured, and the rest of the product (GitHub, CI, `/team`, the Team panel) works. Do not block v0.1 on Feishu.

## Local / Agent Team

`/team` is local-first: it runs in its Team working directory (Execution settings, or `--dir`) and does not need Feishu or GitHub. Use it for greenfield work or a task that spans several repositories; use a Ticket when you need worktree isolation, a PR, CI gating and a reply in the source thread.

## Model gateway

`examples/profile.agent-teamwork.cordis.patch.yml` declares two routes:

- `llm-center`: OpenAI-compatible, `LLM_CENTER_API_KEY`, models such as `deepseek-v4.1-flash-mb`.
- `anthropic-gateway`: Anthropic Messages, `ANTHROPIC_AUTH_TOKEN`, models such as `claude-opus-5-5`.

Run `pnpm spike:gateway` with the token in the environment to see whether the gateway accepts `x-api-key`, `Authorization: Bearer`, or both. On 2026-11-02 the gateway accepted all three for `claude-opus-5-5`, so DSH's `x-api-key` adapter works without a proxy. The script prints only status codes and short response bodies; it never writes the token.

## Sandbox posture

v0.1 develops under the current desktop account with a dedicated DSH profile (`superagent`). The worker and team Sessions get `danger-full-access` inside that profile, as the prototype requires for git worktrees and subprocesses; do not point them at a repository or account with more authority than the task needs. v0.2 moves to a dedicated OS account or container; v1 ships a Docker image. See `docs/003-execution.md` for the worktree model.
