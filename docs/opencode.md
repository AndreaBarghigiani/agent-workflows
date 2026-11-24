# OpenCode native Basic Memory setup

OpenCode discovers the existing `.agents/skills/<name>/SKILL.md` installation
and reads root `AGENTS.md`. A working workflow installation does not establish
an MCP connection: `setup_memory --check` verifies local skills and routing
only. See OpenCode's official [skills](https://opencode.ai/docs/skills/),
[configuration](https://opencode.ai/docs/config/) and
[MCP documentation](https://opencode.ai/docs/mcp-servers/).

## Register the connection

Follow the shared [client connection reference](../.agents/skills/setup-basic-memory/references/client-connection.md)
for the inspect, reuse, conflict and reporting rules. Read `.agents/memory/config.toml`
and confirm the already agreed server name, project scopes, service endpoint and
authentication mode. Use the consumer's deployment documentation for the endpoint.
A mounted NAS share does not prove that the MCP endpoint is reachable.

First use the shared offline inspection and output allowlist. Do not print raw
configuration or debug output. The historical experiment used `opencode debug config --standalone`
from the project directory. It lists each config document with its normalized
`mcp.servers` entries and starts a private server, not the managed background
service. Without `--standalone`, `debug config` and `mcp list` use the managed
service and try to start it when it is down (observed in a sandbox home, where the
start failed because port 49374 was already in use). Check the service state with
the read-only `opencode service status`. Then run `opencode mcp list` from the
project directory for the managed service's connection state (`connected` or
`needs authentication`). Its output depends on the working directory: it printed
`No MCP servers configured` from `/tmp` and in standalone mode, although the global
file had the entry. An empty list is therefore not evidence that no server is
configured.

The configuration shape depends on the installed version, so do not copy one from
another machine. Verified on `opencode` 2.2.0 and the official v2 docs:

- **v2:** servers live under `mcp.servers`, keyed by a unique name. Use
  `disabled: true` to keep an entry without connecting it; v2 has no `enabled`
  field.
- **v1 (legacy):** `mcp.<name>` with `enabled` and `oauth` fields. The 2.2.0 loader
  still reads it and normalizes it to the v2 shape (checked in an isolated home).
  Write new or edited entries in the v2 shape.

Precedence (official v2 config docs, lowest to highest): the global
`~/.config/opencode/opencode.json`, then project `opencode.json` files with closer
directories winning, then `/etc/opencode`, then managed settings. Files inside a
`.opencode/` directory merge after the direct files at the same level. A
higher-precedence server object with the same name replaces the whole lower one;
fields do not merge, so a project entry must repeat every field it needs, such as
headers. Use different names for separate connections. `debug config --standalone`
lists the documents separately and does not print the merged value. The replacement
rule comes from the docs and was not run end to end here. To resolve the winning
entry offline, collect the applicable documents for this working directory,
normalize legacy entries, order them by the precedence above, and select the
last whole server object with the recorded name. Compare its endpoint and auth
references locally; emit only the shared allowlist. Include managed settings and
launch overrides. If any applicable source is inaccessible or the active process
may have stale configuration, report the active mapping unverified and stop;
connection status alone does not settle this. Debug output is supporting evidence,
not a merged effective mapping.

Choose global configuration (`~/.config/opencode/opencode.json`) for a connection
shared across projects, or project configuration (`opencode.json` at the root)
for a project-specific connection. Honor an existing choice; ask only when the
location or endpoint is unresolved. Client configuration edits need existing
user authorization; workflow installation alone does not authorize them.

Adding is a client-configuration change. `opencode mcp add <name> --url <reviewed-endpoint>`
writes the project `opencode.json`, and `--global` writes the global file. Do not
run it for a name that inspection found. Its help lists no `--standalone` option,
so it uses the managed service, and its same-name behavior is unverified. Repair an
existing entry by the owner-authorized edit described below.

Keep credentials out of the file and out of command output. Reference an
environment variable with `{env:NAME}` in a header and quote the argument so the
shell does not expand it, for example
`--header 'Authorization=Bearer {env:BASIC_MEMORY_API_TOKEN}'`. This matches the
official `"Authorization": "Bearer {env:MCP_API_KEY}"` example, and the config then
stores the placeholder rather than the value. The command form is from the official
docs and was not run here.

Remote servers use OAuth unless the entry sets `"oauth": false`, which suits only a
header-only endpoint. That changes the authentication path, so it needs the owner's
decision; do not add it during setup. Do not run `opencode mcp auth` against a
non-OAuth endpoint or change the shared service's authentication policy. The
scripts do not edit OpenCode config, install Basic Memory locally, deploy a server
or install hooks.

For an opted-in consumer (routing `[connection] clients` includes `opencode`),
the helpers instead generate a git-ignored root `opencode.json` carrying
`mcp.servers.<name>` in the v2 shape — `"type": "remote"`, the profile
endpoint, `"oauth": false` (the header-only path recorded in the reviewed
opt-in), and a `Bearer {env:VAR}` header when the profile names a variable.
The merge preserves unrelated file content; a legacy `mcp.<name>` entry, a
conflicting same-name entry and a tracked file are refused. Shadowing
detection inspects these accessible layers: the global file,
`OPENCODE_CONFIG`, ancestor `opencode.json`/`opencode.jsonc` files (lower
precedence — a same-name entry there is a duplicate warning), all discovered
`.opencode/` directory configs, the checkout's `opencode.jsonc`,
`OPENCODE_CONFIG_CONTENT`, `/etc/opencode/*.json(c)`
(higher precedence — a same-name entry there shadows the generated entry and
fails). Configs are parsed as JSONC; a layer that cannot be parsed safely is
reported as an explicit "unverified" diagnostic rather than silently
skipped. See
[project-scope client connections](memory/connections.md).

In OpenCode 2.2.0, `opencode debug config --standalone` can normalize a
legacy `mcp.<server>` entry to `mcp.servers.<server>`. If the active
mapping matches the reviewed endpoint, reuse it and verify a scoped read
in a fresh session. The connection listing alone does not verify a native read.

**Optional owner-authorized migration:** to match the v2 shape, back up the global
file, move the object to `mcp.servers.<server>`, and replace
`"enabled": true` with `"disabled": false` or remove it. Keep the name, `type`,
`url` and any other fields unchanged, and keep `$schema`, `enabled_providers` and
`policies`. Then run `opencode debug config --standalone` from the repo: the name
must appear once, under `mcp.servers`, with no `mcp.<server>` left. The
owner then runs `opencode reload` (or restarts the managed service) and repeats
`opencode mcp list` from the repo. A fresh OpenCode session then runs the read-only
native read in the verification section below, which is the remaining live gap.
Setup does not perform these steps. Until the migration, the v1 entry relies on the
2.2.0 normalization, which a later release could drop.

## Reload and verify in T3 Code

OpenCode must load the updated configuration before the session can use its
tools. In T3 Code, use the available provider/session restart or reload control;
starting a new thread is sufficient only if it starts a fresh OpenCode process.
Do not kill the harness-managed provider from within its own session. Verify
that the new session actually exposes the configured MCP tools rather than
assuming a UI action reloaded the configuration.

Where the CLI is available, `opencode mcp list` from the project directory shows
the managed service's state for the configured servers (see above). Skill
discovery has no verified v2 command here; `opencode debug --help` lists the
installed debug subcommands. In the active session, inspect the exposed tool
schemas, then run a read-only native search or read within the configured project
and read scope. A successful empty query counts as access. Do not write, create
notes, or run a disposable write: remote writes are outside this setup. Project
listing is optional and may be unscoped; pass `project` only on tools that support
it. Listing projects alone does not prove project-scoped read access.

If tools are absent or connection fails, inspect config precedence, endpoint
reachability, TLS and the service's authentication mode. Report unsaved progress
when memory is unavailable. Tool permission prompts are separate from project
routing; follow the user's permission policy rather than broadly allowing every
memory tool to suppress prompts.

## Use the configured project without repeated selection

Read `.agents/memory/config.md` before memory work. Pass the configured write
project explicitly on scoped write tools and use the configured default read
projects in order; related reads require the configured task-specific reason.
Do not ask the user to choose an already configured project again, and do not
change the server's shared default project to select this checkout. Clarify
missing, contradictory or out-of-scope routing. Routing does not authorize a
write or unrelated project access.

The setup script now generates this guidance, so consumers do not need to edit
its generated file or add a duplicate project-specific instruction to `AGENTS.md`.
Run setup to upgrade the exact previous generated v2 instructions, then run it
again and use `--check`. Customized instructions and consumer `AGENTS.md` prose
are preserved; reconcile conflicting local routing prose explicitly. A routing
note saved in memory is supporting context and cannot override local routing.
