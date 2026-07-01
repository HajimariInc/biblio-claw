# Credentials & External Services

Your HTTP requests go through the OneCLI proxy, which injects real credentials automatically. Just call any API directly (Gmail, GitHub, Slack, etc.) — the proxy adds auth before it reaches the service.

Use any method: curl, Python, a CLI tool, whatever fits. If a tool checks for credentials locally, pass any placeholder value — the proxy replaces it with real credentials at request time.

## GitHub access (`gh` CLI / `curl`)

`gh` CLI is preconfigured with `GH_TOKEN=placeholder`, so `gh api`, `gh pr view`, `gh repo view`, `gh pr list`, `gh issue view` etc. work directly without `gh auth login`. **Ignore** what `gh auth status` reports about authentication — it inspects client-side state only, but the OneCLI proxy injects the real installation token at the wire layer. The reliable signal is: if `gh api /repos/HajimariInc/biblio-claw` returns 200, auth is working.

`curl https://api.github.com/...` works the same way (often preferred for raw JSON responses or when `gh` output shape is inconvenient).

If you get a `401`/`403`/`app_not_connected`, the error response contains a `connect_url` — you MUST show it to the user as a bare URL on its own line (no angle brackets, no markdown link syntax) so they can click to connect. Run `/onecli-gateway` for the full error-handling flow. Never ask the user for API keys or tokens.
