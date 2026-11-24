# Project-scope client connections

Routing (`.agents/memory/config.toml`) records which Basic Memory project a
checkout uses. A **connection** is how a client reaches the service at all:
a server name mapped to an endpoint and authentication. This library can
generate project-scope connection files so a consumer's memory tools work in
every checkout of that project — including harness-created worktrees —
without editing home-folder client configuration. The feature is opt-in per
consumer; without it, connection setup stays the manual, separately
authorized procedure in the
[client connection reference](../../.agents/skills/setup-basic-memory/references/client-connection.md).

## The storage model

- **Generated and git-ignored.** Claude `.mcp.json`, Codex
  `.codex/config.toml` (`[mcp_servers.<name>]`) and OpenCode `opencode.json`
  (`mcp.servers.<name>`) entries are rendered into the checkout, ignored by
  Git, and regenerated wherever needed. Nothing infrastructure-specific is
  committed to a consumer repository, and tracked client files are never
  overwritten — a tracked file is **consumer-owned**: the check validates
  that a registration maps to the memory service (the routing's
  `mcp_server` name or an endpoint-equivalent name) and structurally
  satisfies it, and reports a targeted alignment instruction when it does
  not. Generation stays blocked for tracked files. See
  [configure-mcp migration and onboarding](../mcp-configure-migration.md).
- **One machine-local profile, outside every checkout.** Each machine keeps a
  single profile at
  `$XDG_CONFIG_HOME/agent-workflows/memory-connection.toml`
  (`~/.config/agent-workflows/memory-connection.toml` by default). It holds
  the endpoint and the environment-variable **name** the client reads its
  bearer token from. Being outside the checkout, it is available to every
  worktree; being machine-local, it never reaches a repository.
- **No credential values, anywhere.** The profile and every generated file
  carry only the variable's name — `Bearer ${VAR}` for Claude,
  `Bearer {env:VAR}` for OpenCode, `bearer_token_env_var` for Codex — and the
  client resolves the value at runtime. The helpers never read the variable's
  value, and an endpoint with embedded credentials (userinfo) is rejected.
- **A selection that survives worktrees.** The reviewed client selection is
  embedded in the generated `.agents/memory/config.md` as a comment marker;
  the T3 routing-source copy carries it to every worktree — as long as the
  tracked routing source is reconciled and committed **after** opting in
  (see [Keeping worktrees current](#keeping-worktrees-current)).
- **Ownership, not shape.** The helper records the entries it generated in a
  git-ignored `.agents/memory/connections.json` inside each checkout. Only a
  recorded entry is regenerated on a profile change; a hand-written or
  hand-edited same-name entry is reported and preserved — shape alone never
  proves ownership, so the helper never claims a manual config as its own.

### Trade-offs

- Every machine needs the profile once. A missing or invalid profile stops
  generation with a named error rather than silently leaving a checkout
  without memory.
- Clients keep their native precedence, so an existing local- or user-scope
  entry with the same name can shadow or duplicate the generated project
  entry. The check reports them — it never moves, overwrites or deletes
  client configuration.
- Codex reads a project's `.codex/config.toml` only for trusted paths.
  Upstream resolves a linked worktree against the **main checkout's** trust
  entry through the common Git directory, so trusting the main checkout
  covers its worktrees; an explicit `[projects."<worktree>"]` entry — with
  an explicit trust level — takes precedence over that fallback. Claude
  Code approves a project `.mcp.json` server through settings or a one-time
  interactive prompt; `claude -p` and Agent SDK sessions with the projectSettings source enabled load project
  servers without that prompt according to upstream; this remains unverified here. Codex trust is a check failure; Claude approval is a warning requiring live verification.
- A partial move can leave the same server name in several scopes; that is
  reported, not cleaned up automatically.

## Set up a consumer from scratch

1. **The service.** Have a running Basic Memory service — a local
   `basic-memory`/`bm` instance or a remote endpoint. This library does not
   deploy or change it. Record the reviewed endpoint URL and whether it
   requires a bearer token.
2. **The machine profile** (once per machine, per OS account):

   ```toml
   # ~/.config/agent-workflows/memory-connection.toml
   schema_version = 1
   endpoint = "https://<your-service-host>/mcp"
   bearer_token_env = "BASIC_MEMORY_API_TOKEN"   # optional; NAME only
   ```

   Omit `bearer_token_env` when the service needs no token. Export the
   variable itself however the machine manages secrets; it is never written
   to a file by this library. Pick a name the client does not treat as its
   own credential (the profile check refuses known-reserved names such as
   `ANTHROPIC_AUTH_TOKEN`).
3. **Reviewed routing.** Add the opt-in table to the v2 routing input —
   select only the clients actually used:

   ```toml
   schema_version = 2

   [project]
   id = "my-project"

   [memory]
   write_project = "my-project"
   search_projects = ["my-project"]
   related_projects = []
   mcp_server = "basic_memory"

   [connection]
   clients = ["claude", "codex", "opencode"]
   ```

   `mcp_server` stays the connection name every rendered file uses. Devin and
   Grok take no generated file (Devin inherits the T3 servers; Grok follows
   the generic client steps until integrated), so they are not valid
   `clients` values.
4. **Setup** from the consumer root:

   ```bash
   node .agent-workflows/bin/agent-workflows.ts setup_memory --project . \
     --portable <reviewed-config.toml>
   node .agent-workflows/bin/agent-workflows.ts setup_memory --project . --check
   ```

   Setup writes routing, instructions and ignore entries, then renders the
   connection files: it creates a missing file, merges the managed entry into
   an existing untracked file preserving unrelated settings, validates a
   tracked file's consumer-owned entry instead of writing it, and refuses a
   conflicting same-name entry.
5. **Approvals, per client.** Claude Code approves a project `.mcp.json`
   server through `enabledMcpjsonServers` or `enableAllProjectMcpServers` in
   user, managed, or untracked local settings, or through a one-time
   interactive prompt (recorded in `~/.claude.json`); committed
   `.claude/settings.json` entries apply once the workspace is trusted, and
   `disabledMcpjsonServers` anywhere rejects the entry outright.
   Non-interactive `claude -p` and Agent SDK sessions with the projectSettings source enabled load project servers
   without the interactive prompt according to upstream; this is unverified
   here. Approval is warning-only: verify effective tools in both T3/SDK
   and `claude -p` during the live pilot. Codex needs the checkout trusted — the main
   checkout's entry covers linked worktrees through the common Git
   directory, while an explicit worktree trust level wins over it: approve the
   first-run prompt or record `trust_level` under `[projects."<path>"]`
   yourself; the helper never edits `~/.codex/config.toml` or any other
   global client configuration. OpenCode applies the project file directly.
   The generated OpenCode entry carries `"oauth": false` because the
   documented authentication is a header token; an OAuth-protected service
   is a separate owner decision outside the generated path.
6. **Upstream skills and schemas are unchanged.** Install Basic Memory's own
   skills at the release matching the server per
   [installing Basic Memory's skills](upstream-skills.md). Inspecting and
   creating `Decision`/`Pattern` schemas still follows `setup-basic-memory`;
   schema creation is a remote write that needs existing explicit write
   authorization — connection setup does not grant it.
7. **Verify.** `--check` reports missing or drifted files, missing ignore
   entries, shadowing and duplicate home-folder entries, and missing
   prerequisites (profile, Codex trust, Claude approval). Then verify a
   fresh-session scoped search and read per the client guides; file checks
   do not prove MCP access.

## The worktree command

`setup_memory_connections.ts` renders and checks the same files from the
selection recorded in the generated `.agents/memory/config.md` — the artifact
T3 readiness restores into every worktree — so it works even where the
reviewed `config.toml` itself is git-ignored and absent:

```bash
node .agent-workflows/bin/agent-workflows.ts setup_memory_connections --project .
node .agent-workflows/bin/agent-workflows.ts setup_memory_connections --project . --check
```

When no connection selection is recorded it exits 0 doing nothing, so it is
safe to compose unconditionally for memory-enabled consumers — and harmless
for declined ones. A failed run names the exact missing prerequisite (the
profile, an ignore entry, an unaligned consumer-owned entry, shadowing, or
— under `--check` — Codex trust).

When the consumer tracks a client file, the command validates the tracked
memory registration instead of rendering it — an inherited tracked entry
that is verifiably aligned passes without writes, and a missing or
conflicting one fails with the targeted alignment instruction.

To wire worktrees, compose it into the consumer's existing T3 worktree setup
action after the generated readiness launcher — the library ships the
command; the consumer owns the action:

```
node .agent-workflows-t3.mjs && \
  node .agent-workflows/bin/agent-workflows.ts setup_memory_connections --project .
```

See [T3 Code worktree setup](../t3-checkout-readiness.md): only the first
`runOnWorktreeCreate` action executes, so compose rather than add a second
setup action.

## Keeping worktrees current

A worktree receives the connection selection only through the **tracked**
routing source that T3 readiness restores from — the marker lives in the
ignored generated `config.md`, and `config.toml`, the ownership record and
the rendered client files are all ignored too. So after opting in (or
changing the selection), reconcile and commit the tracked source **before**
creating worktrees:

```bash
node .agent-workflows/bin/agent-workflows.ts t3_readiness --project . --reconcile-routing-source
git add <routing-source-path> .gitignore
git commit -m "sync memory routing source with connection opt-in"
```

Both helpers detect the drift and refuse to pass silently:

- In the main checkout, render and `--check` compare the tracked routing
  source to the current generated routing and report "routing-source
  drift" with the reconcile command.
- In a fresh worktree whose restored routing predates the opt-in, the
  standalone command fails naming the reconcile route instead of reporting
  "not configured": the committed `.gitignore` still carries the connection
  ignore entries, which indicates a selection was previously recorded — even
  though the ignored ownership record cannot travel there.

The reconcile route is the only repair for ignored connection files in a
worktree, because `setup_memory.ts --project .` needs `config.toml`, which
worktrees intentionally do not have. Fix the main checkout, commit, then
rerun the worktree setup action (or the standalone command).

## Client specifics

Managed coverage is limited: the check reads Claude `/etc/claude-code/managed-settings.json`;
OpenCode scans `/etc/opencode/*.json` and `*.jsonc`; the Codex check reads only user
configuration, not managed policy. Other managed files, drop-ins and platform
paths need separate inspection. These checks do not establish effective runtime
configuration.


| Client | Generated file | Scope | Per-checkout prerequisite | Same-name precedence |
|---|---|---|---|---|
| Claude Code | `.mcp.json` | project | approval (settings or one-time prompt) | local > project > user (whole entry) |
| Codex | `.codex/config.toml` `[mcp_servers.<name>]` | trusted project | path trust (main checkout covers worktrees; an explicit worktree trust level overrides) | field-level merge; project fields win |
| OpenCode | `opencode.json` `mcp.servers.<name>` | project | — | `.opencode` directory configs override every direct file; then `opencode.jsonc`, `OPENCODE_CONFIG_CONTENT`, `/etc/opencode` and managed settings |
| Devin | — | inherits the T3-configured servers | — | — |
| Grok / others | — | generic client steps until integrated | — | — |

Shadowing detection inspects `~/.claude.json` (this path's local scope and
the user scope), the accessible Claude settings files
(`~/.claude/settings.json`, managed settings, `.claude/settings.local.json`
and committed `.claude/settings.json` — `--settings`, `--setting-sources`
and permission modes are runtime-only and documented here as uninspectable),
`$CODEX_HOME/config.toml` or `~/.codex/config.toml` (trust, including the
main-checkout fallback for linked worktrees, and the user layer's
field-level contributions), and these accessible OpenCode layers:
`~/.config/opencode/opencode.json`, `OPENCODE_CONFIG`, ancestor
`opencode.json`/`opencode.jsonc` files (lower precedence), all discovered
`.opencode/` directory configs, the checkout's `opencode.jsonc`,
`OPENCODE_CONFIG_CONTENT`, `/etc/opencode/*.json(c)` (higher precedence). OpenCode configs are parsed as JSONC; a layer that
cannot be parsed safely is reported as an explicit "unverified" diagnostic,
never silently skipped. Only names, scopes and endpoint match/mismatch are
reported — never values. Claude `CLAUDE_CONFIG_DIR` relocations are honored;
unreadable discovered files are reported as unverified; directory enumeration
may miss inaccessible managed directories.

## Moving a consumer from a home-folder connection

Existing global or local-scope entries are detected and reported, never
moved, overwritten or deleted automatically. The gradual path, per client:

1. Opt in and run setup. If the existing entry would shadow the project
   entry (a Claude local-scope entry, Codex user fields the project layer
   does not set, an `/etc` OpenCode entry), setup refuses and names it —
   reconcile that entry first.
2. Verify the project entry works in a fresh session.
3. Only then, deliberately, remove the home-folder entry — building on the
   [rename procedure](migration.md#rename-the-connection-to-basic_memory) in
   the migration guide, which covers keeping name, permissions and routing
   aligned. Keep the global entry while any other project still uses it:
   project entries win for the opted-in consumer, so the move is safe to do
   one project at a time. A user who prefers to keep the global connection
   simply does not opt in; nothing changes for them.

## Other scenarios

- **A teammate or a new machine:** create the profile once, check out, run
  setup — or let the worktree action render. No home-folder client edit is
  needed.
- **Memory declined:** no `[connection]` table, no profile needed, nothing
  rendered or checked; the standalone command exits doing nothing.
- **A consumer that shares `.agents/memory/`:** routing input is tracked, so
  worktrees carry it too; the standalone command still derives the same
  selection and renders identically.
- **New worktree recovery:** the setup action restores routing and renders
  connections. If the profile is missing on that machine the command fails
  naming the exact path; create it and rerun. Codex inherits the main
  checkout's trust through the common Git directory, so a linked worktree
  needs no separate approval — unless a `[projects."<worktree>"]` entry of
  its own exists and overrides the fallback; `--check` says so.
- **Changing the profile:** edit the machine profile and rerun the setup or
  standalone command. Entries the helper recorded as generated are
  regenerated in place; an entry anyone edited after generation is refused
  for review, and a same-name entry that was never recorded is preserved
  with a diagnostic — nothing is silently overwritten.
- **Deselecting a client:** remove it from `clients`; setup reports any
  recorded generated leftover entry for the routing server name and
  preserves it for manual removal — it never deletes client configuration.
  Removing the whole `[connection]` table reports the same leftovers through
  the ownership record, as does the standalone command. An unrecorded
  same-name entry (hand-written, or predating ownership tracking) is a
  warning, not a blocker.
- **A consumer that never opted in:** no profile, no ownership record, no
  generated files — and existing hand-written `.mcp.json`,
  `.codex/config.toml` or `opencode.json` entries are simply left alone.

## Boundaries

The helpers write only inside the checkout, only the generated files listed
above plus the consumer's `.gitignore`. They never edit home-folder client
configuration, never change Codex trust, never read credential values, never
stage or commit, and never deploy or probe the service. Live MCP access is
verified separately per the client guides.

When replacing a formerly generated entry with a manual one, remove it first,
rerun setup to release ownership, then add the manual entry. Removing or
emptying `[connection]` follows the same cleanup procedure.

For a full opt-out, after removing the generated entries and rerunning setup,
review and remove the connection-specific ignore lines from `.gitignore`, then
commit that change together with the reconciled routing source. Setup preserves
ignore rules automatically, so leaving those lines behind makes a fresh worktree
report a stale opt-in even though the main checkout has released ownership.
Remove the connection-generation command from the consumer's T3 setup action
if it is no longer wanted. Verify the opted-out setup in a fresh worktree;
keep any ignore rule still needed by unrelated manually managed configuration
and remove the connection-generation command instead in that case.
