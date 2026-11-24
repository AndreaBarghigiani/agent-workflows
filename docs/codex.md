# Codex native Basic Memory setup

This document is setup guidance for agents performing Codex setup. It is not a
consumer instruction file. Follow the shared
[client connection reference](../.agents/skills/setup-basic-memory/references/client-connection.md)
for the inspect, reuse, conflict, and reporting rules; this page supplies the
Codex-specific commands.

Codex discovers the `.agents/skills` installation and reads root `AGENTS.md`
through the workflow install. An installed skill does not establish an MCP
connection, and `setup_memory --check` verifies only local artifacts.

## Evidence

- Linux validation with Codex CLI 0.165.0 used temporary configuration
  to exercise same-name re-add, trusted and untrusted project layers, and
  field merging. Live Basic Memory reads were outside that validation.
- Configuration reference: the official
  [Codex MCP documentation](https://developers.openai.com/codex/mcp) and
  [config basics](https://developers.openai.com/codex/config-basic).

## Inspect the effective configuration

Follow the shared offline-first rule: read `~/.codex/config.toml` and the
trusted project's `.codex/config.toml` with a local TOML parser and report only the
allowlisted fields (name, scope, enabled, transport, endpoint match, credential
reference name). Then confirm the merged result with the two commands below, and
report only the same allowlisted fields from their output, never the raw text.

```bash
codex mcp list
codex mcp get <server-name>
```

`codex mcp list` prints each server's URL, enabled state and auth mode. It does not
probe the endpoint: in the sandbox, an entry for an unresolvable host listed as
`enabled` with no error. `codex mcp get` prints the effective values after layers
are merged (see below). Neither output is evidence of access.

Precedence (official config basics, highest first): command-line `-c` overrides,
then the closest trusted project `.codex/config.toml`, then the user
`~/.codex/config.toml`. Codex skips a project's `.codex/` layers when the project is
not trusted. Trust is recorded in the user config under `[projects."<path>"]` with
`trust_level`.

Layers merge field by field. Verified in a temporary `CODEX_HOME`: with the project
trusted, its `url` replaced the user `url`, while the user's `bearer_token_env_var`
stayed effective. A same-name project entry can therefore redirect the endpoint
while keeping the user's credential reference. Before reuse, read both
`~/.codex/config.toml` and the project's `.codex/config.toml` for the server name,
and confirm the effective `url` with `codex mcp get` from the consumer root.

## Reuse, conflict, and add

- **Reuse:** an entry named `mcp_servers.<server>` with the reviewed URL and no
  unexpected field-level override. Keep it.
- **Conflict:** the same name with another URL, or a project layer that changes the
  effective value. **`codex mcp add` overwrites an existing entry with that name
  without warning.** Stop and report the conflict before changing the entry.
- **Missing, with authorization:** the endpoint is the reviewed HTTP URL. Add it
  with the server name recorded in local routing:

  ```bash
  codex mcp add <server-name> --url <reviewed-endpoint>
  ```

  If the service needs a bearer token, add `--bearer-token-env-var <ENV_VAR>` (listed
  in `codex mcp add --help`). The config then names the variable, and Codex reads its
  value at runtime. Never place the token in the command or the handoff. An
  OAuth-protected service uses `codex mcp login <server-name>` only when the owner
  asks for that flow.

`codex mcp add` writes the global configuration (`~/.codex/config.toml`) in the
versions checked. Writing it is a client-configuration change that needs the same
explicit authorization as any other. Setup never edits it implicitly. Record the
scope the owner accepts; a project-scoped entry is a separate, reviewed edit. After
any authorized add, confirm that other entries in the file are unchanged. The sandbox
checked only a single entry.

## Generated project layer

For an opted-in consumer (routing `[connection] clients` includes `codex`),
the helpers append the generated `[mcp_servers.<name>]` table to the checkout's
`.codex/config.toml` — URL plus `bearer_token_env_var` naming the variable,
never a value — and git-ignore that file. The table is appended, so existing
untracked settings are preserved; an inline `mcp_servers` structure that
cannot be extended, a conflicting same-name entry, and a tracked file are all
refused for review. Two caveats stay owner-managed: trust and user-layer
merging. Trust is recorded per path under `[projects."<path>"]`, but upstream
resolves a linked worktree against the **main checkout's** entry through the
common Git directory — trusting the main checkout covers its worktrees, and
only an explicit worktree entry (with an explicit trust level) overrides
that fallback. `--check` names the missing prerequisite and never edits
`~/.codex/config.toml`. A user-layer same-name entry still contributes
fields the project layer does not set — the check reports those field-level
leaks. See
[project-scope client connections](memory/connections.md).

## Repeat setup

Repeat the offline inspection (then `codex mcp list` and `codex mcp get <server-name>`) before any add. A
matching entry is reused, so a repeated setup creates no duplicate. A changed entry
is reported as a conflict and left alone; the workflow does not run `add` to replace
it.

## Reload and verify

Start a new Codex session in the consumer root after a configuration change, then
confirm that the session exposes the intended server's tools. The reload
behavior of a running session was not verified in this check; treat a session
that was already open as unverified.

In that session, ask Codex to use the server's native read or search tool with
the configured project and read scope. A successful empty query counts as access.
Record the Codex version, machine, server name, tool, project, read scope, and the
actual outcome. Do not create notes, schemas, or test writes to check access.

## Gaps

- Verify native Basic Memory access in a fresh session using the scoped read above.
- Codex's behavior with an unreachable endpoint was not probed; `codex mcp list` and
  `codex mcp get` do not test reachability.
- The Codex session reload behavior and the project-layer precedence in a live
  session were not verified; the sandbox checks cover only the configuration layer.
