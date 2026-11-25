# AnyList MCP server

An MCP server that lets Claude read and update your [AnyList](https://www.anylist.com) shopping lists, meal planning calendar and recipes.

AnyList has no public API. This uses the unofficial, reverse-engineered [`anylist`](https://www.npmjs.com/package/anylist) Node library (github.com/codetheweb/anylist, now maintained at kevdliu/anylist), pinned to **0.8.6**. AnyList can change its private API at any time and break it. See [Library status](#library-status-checked-2026-11-25).

- TypeScript, official MCP SDK
- **stdio** transport for local use (Claude Desktop, Claude Code)
- **Streamable HTTP** transport for a remote **custom connector** in Claude, protected by a bearer token and/or a single-user OAuth flow

## Tools

| Tool | What it does |
| --- | --- |
| `list_lists` | All lists with total, unchecked and checked item counts |
| `get_list(name, include_checked?)` | Items with checked state, quantity, category and notes |
| `add_item(list, name, quantity?, notes?, category?, allow_duplicate?)` | Adds an item. If the same item is already on the list crossed off, it un-checks and reuses it, like the AnyList apps do |
| `update_item(list, name \| item_id, new_name?, quantity?, notes?, category?, checked?)` | Edits an item. Only changed fields are sent |
| `check_item` / `uncheck_item(list, name \| item_id)` | Crosses an item off, or puts it back |
| `remove_item(list, name \| item_id, confirm)` | **Deletes** an item. Does nothing unless `confirm=true` |
| `get_meal_plan(start_date, end_date)` | Meal calendar events in a date range (inclusive, `YYYY-MM-DD`) |
| `add_meal_plan_event(date, recipe?, note?, label?)` | Adds a recipe, a note (e.g. "Leftovers"), or a recipe with a note. `label` is e.g. "Dinner" |
| `remove_meal_plan_event(event_id, confirm)` | **Deletes** a meal plan event. Does nothing unless `confirm=true` |
| `get_recipes(query?)` | Recipe box, optionally filtered by name |
| `get_recipe(name)` | Ingredients, steps, servings, times, source and notes |

List, item and recipe names are matched case-insensitively. If several items share a name, the tool returns their ids and asks for `item_id`. Without `confirm=true`, the delete tools return the item or event they would delete and change nothing. Both are annotated `destructiveHint: true`.

Not supported: creating, renaming or deleting lists (the library can't), and creating or editing recipes (reported broken upstream, see below).

## Security

- **Credentials come only from environment variables** (`ANYLIST_EMAIL`, `ANYLIST_PASSWORD`). They are never put in tool results or logs.
- **All logging goes to stderr and is redacted.** The library's own `console.*` output is captured. Your password, email, the AnyList access, refresh and client tokens, `MCP_AUTH_TOKEN`, any `Bearer …` value and JWT-looking strings are replaced with `[REDACTED]`. Library errors are reduced to "HTTP <status>" before reaching Claude, because errors from `got` carry request headers.
- **The HTTP endpoint always requires auth.** The server refuses to start without an `MCP_AUTH_TOKEN` of at least 32 characters.
  - The **static bearer token** (`Authorization: Bearer $MCP_AUTH_TOKEN`) is for Claude Code, scripts and curl.
  - **OAuth 2.1** (enabled by setting `PUBLIC_URL`) is for claude.ai custom connectors. When you connect, Claude opens an approval page on your server. You type `MCP_AUTH_TOKEN` there to approve. PKCE is required, codes are single use and expire in 5 minutes, access tokens last 1 hour, and refresh tokens last 30 days and rotate. Tokens are stored only as SHA-256 hashes. Client registration only accepts redirect URIs on `OAUTH_ALLOWED_REDIRECT_HOSTS` (default `claude.ai,claude.com,localhost,127.0.0.1`).
  - Five wrong passwords from one IP, or 20 in total, lock the approval page for 15 minutes. The trade-off is that someone hammering it can block *you* from approving for that window. The static token keeps working.
- `ANYLIST_CREDENTIALS_FILE` (optional) lets the library cache its AnyList session on disk, AES-encrypted with your AnyList password. Leave it unset to keep the session in memory and log in again on each start.

## Setup

Requires Node 20+.

```bash
cd anylist-mcp
npm install
npm run build
npm test            # all mocked; never contacts AnyList
cp .env.example .env   # fill in ANYLIST_EMAIL / ANYLIST_PASSWORD
```

### Check it works with your account (read-only)

```bash
set -a; . ./.env; set +a
npm run smoke
```

This logs in, then reads your lists, this week's meal plan and your recipe count. It **never writes**. Run it first, because it is the only real check that the unofficial API still works with your account.

### Local use (stdio)

**Claude Code:**

```bash
claude mcp add anylist \
  -e ANYLIST_EMAIL=you@example.com -e ANYLIST_PASSWORD='…' \
  -- node /absolute/path/to/anylist-mcp/dist/index.js --stdio
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "anylist": {
      "command": "node",
      "args": ["/absolute/path/to/anylist-mcp/dist/index.js", "--stdio"],
      "env": { "ANYLIST_EMAIL": "you@example.com", "ANYLIST_PASSWORD": "…" }
    }
  }
}
```

### Run the HTTP server locally

```bash
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
ANYLIST_EMAIL=… ANYLIST_PASSWORD=… node dist/index.js --http
curl -s localhost:3000/mcp -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The server is stateless Streamable HTTP: `POST /mcp` only. It also serves `GET /healthz`, plus the OAuth endpoints when `PUBLIC_URL` is set (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`, `/register`, `/authorize`, `/token`, `/revoke`, `/oauth/approve`).

## Deploy

claude.ai needs a public **HTTPS** URL. Both options below persist `/data` (OAuth state plus the cached AnyList session), so Claude stays connected across restarts.

### Fly.io

```bash
cd anylist-mcp
# edit fly.toml: set `app` and PUBLIC_URL (https://<app>.fly.dev)
fly launch --no-deploy --copy-config
fly volumes create anylist_data --size 1
fly secrets set ANYLIST_EMAIL=you@example.com ANYLIST_PASSWORD='…' MCP_AUTH_TOKEN=$(openssl rand -hex 32)
fly deploy
fly logs   # look for "AnyList MCP listening"
```

Save the `MCP_AUTH_TOKEN` in your password manager, because you'll need it on the approval page. The machine auto-stops when idle and auto-starts on the next request. The first call after a stop takes a few seconds.

### Hetzner (or any VPS) with Docker and Caddy

Point a DNS record (e.g. `anylist.example.com`) at the box, open ports 80 and 443, then:

```bash
git clone <this repo> && cd <repo>/anylist-mcp/deploy/hetzner
cp ../../.env.example .env
# In .env set: ANYLIST_EMAIL, ANYLIST_PASSWORD, MCP_AUTH_TOKEN=$(openssl rand -hex 32),
#              PUBLIC_URL=https://anylist.example.com, DOMAIN=anylist.example.com
chmod 600 .env
docker compose up -d --build
docker compose logs -f anylist-mcp
```

Caddy gets a Let's Encrypt certificate automatically. The MCP container isn't published on the host; only Caddy can reach it.

**Without Docker:** run `node dist/index.js --http` under systemd with `EnvironmentFile=/etc/anylist-mcp.env` (mode 600) behind your existing reverse proxy, and set `TRUST_PROXY=1`.

### Add it to Claude as a custom connector

1. In Claude, go to **Settings → Connectors → Add custom connector**.
2. URL: `https://<your-host>/mcp`. Leave the OAuth client ID and secret blank; Claude registers itself.
3. Claude opens your server's approval page. Enter `MCP_AUTH_TOKEN` and click **Allow**.

Claude Code can use the static token instead:

```bash
claude mcp add --transport http anylist https://<your-host>/mcp --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

To revoke everything, rotate `MCP_AUTH_TOKEN` and delete `/data/oauth-state.json`, then restart.

## Configuration

See [.env.example](.env.example). Summary:

| Variable | Default | |
| --- | --- | --- |
| `ANYLIST_EMAIL`, `ANYLIST_PASSWORD` | (required) | AnyList login |
| `ANYLIST_CREDENTIALS_FILE` | unset (memory only) | Encrypted AnyList session cache |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` (`--stdio`/`--http` flags override) |
| `MCP_AUTH_TOKEN` | (required for http) | Bearer token and OAuth approval password, ≥32 chars |
| `PUBLIC_URL` | unset | Public HTTPS base URL; enables OAuth |
| `OAUTH_STATE_FILE` | unset (memory) | Persist OAuth clients and hashed tokens |
| `OAUTH_ALLOWED_REDIRECT_HOSTS` | `claude.ai,claude.com,localhost,127.0.0.1` | Allowed OAuth redirect hosts |
| `HOST`, `PORT` | `0.0.0.0`, `3000` | HTTP bind |
| `TRUST_PROXY` | off | Set `1` behind Fly, Caddy or nginx so rate limits see real client IPs |
| `LOG_LEVEL` | `info` | `debug`, `info` or `silent` |

## Tests

`npm test` runs everything with mocked AnyList responses. No network access and no credentials are needed:

- `test/service.test.ts`: tool logic against a fake library (matching, duplicates, confirm gating, dates, recipes)
- `test/library-integration.test.ts`: the **real** `anylist` library classes with only their HTTP client mocked. It feeds them a protobuf-encoded account fixture and decodes the protobuf operations they would send, e.g. `set-list-item-checked=y`, `add-shopping-list-item`, `new-event`, `delete-event`
- `test/tools.test.ts`: MCP tool surface, annotations, and secret redaction of library errors
- `test/http.test.ts`: bearer auth, and the full OAuth flow (registration allowlist, approval password, PKCE, single-use codes, refresh rotation, lockout)
- `test/redact.test.ts`, `test/config.test.ts`

## Library status (checked 2026-11-25)

- **Maintenance:** low activity but not abandoned. 0.8.6 (May 2026) synced the protobuf definitions from the AnyList web app and fixed quantity encoding. There have been no commits since. No open reports of login or list breakage.
- **Known upstream issues that affect this server:**
  - Setting an item's **category** is reported flaky (#50). This server sends the category's `categoryMatchId`, which is what the library supports. If categories don't stick, AnyList may still auto-categorize by name. Reading categories works from the list's category data.
  - Recipe **create/edit/delete** is reported broken (#59, fix PR #58 unmerged), so this server only *reads* recipes.
  - Meal-plan events with a null date (PR #56, unmerged) would be mis-dated by the library. This is rare.
- **Security:** the library pins `protobufjs@5.0.3`, which has published advisories (#63) and no fix within v5. Most concern generating code from untrusted schemas or converting untrusted JSON. Here the schema is bundled and data is only decoded from anylist.com over TLS, so the exposure is limited to a malicious or compromised AnyList server. It can't be overridden to v7, because the library uses the v5 API.
- The library's websocket (live updates) is **not** used. Every tool call fetches fresh data.
