---
name: configure-mcp
description: Check this project's MCP requirements and align selected services with Claude, Codex, OpenCode and Antigravity on this machine; check-only by default, edits only after explicit owner confirmation of a redacted plan.
---

# Configure MCP

Check which MCP services this project declares in
`.agents/mcp-requirements.json`, how the selected clients' project
configuration covers them on this machine, and — only after explicit owner
confirmation of a reviewed plan — apply the bounded edits that align the
selected services. Covered clients: Claude (`.mcp.json` plus the
`.claude/settings.local.json` approval signals), Codex
(`.codex/config.toml`), OpenCode (`opencode.json`), and Antigravity
(`.agents/mcp_config.json`, opt-in via `--clients`). The manifest contract is
documented in [MCP service requirements](../../../docs/mcp-requirements.md);
all work goes through the deterministic helper
[`scripts/mcp_configure.ts`](../../../scripts/mcp_configure.ts).

## Check only (default)

The check path is the default and writes nothing — no configuration,
installation or authentication changes, ever:

```bash
node bin/agent-workflows.ts mcp_configure check --root . \
  --clients claude,codex,opencode,antigravity [--mapping FILE] [--machine FILE]
```

`--mapping` is a JSON file holding the owner's confirmed
service→client→registration names (`{"service-id": {"claude": "name"}}`);
`--machine` is a JSON descriptor naming the environment variables and
executables present on this machine and the resolved `local_config_ref`/
`command_ref` details. Both contain names and pointers only — never values.
Without a mapping, matching registrations surface as unconfirmed candidates.

Report each declared service per client with its state:

- `satisfied` — configuration covers the declared connection.
- `proposed` — an actionable candidate or missing registration; nothing is
  confirmed or applied yet.
- `conflict` — same-name clash, auth mismatch, duplicate or shadowed
  registrations, explicit disables: requires explicit owner resolution.
- `missing-executable` — the launch command does not resolve here.
- `auth-unverified` — credentials are referenced; login and read access are
  unverified (see reporting rules).
- `unsupported` — transport or syntax the client cannot express.
- `unknown-inspection` — the registration cannot be classified; reported as
  unknown, never as missing.

## Authorized setup

Setup runs only when the owner asks to align services, and proceeds as a
recorded sequence:

1. Run `check` and read the results.
2. Propose a mapping: reuse matching registrations under their existing
   names (never rename), or plan new entries for uncovered services.
3. The owner confirms the selections and mapping; record them in the JSON
   input files.
4. Build the redacted plan:
   `node bin/agent-workflows.ts mcp_configure plan --root . --clients ... \
   --mapping FILE [--machine FILE] [--selections FILE] --out PLAN`.
   It contains translated entries, approval additions, destination digests
   and conflicts — names and pointers only.
5. The owner reviews the plan: sets `"confirmed": true` and records a
   `resolution` (`keep`, `reenable`, `replace` or `add`) on every
   `conflict-needs-resolution` action.
6. Apply: `node bin/agent-workflows.ts mcp_configure apply --plan PLAN --confirm`.
   `--confirm` is the recorded explicit go-ahead after owner review. The
   helper re-reads every destination and refuses the whole plan — zero
   writes — on a stale digest, a missing confirmation, an unresolved
   conflict or a malformed plan. A successful apply refreshes the plan
   file's digests and applied markers, so re-running it is a verified
   no-op.

## Authorization

- Prior alignment, earlier runs, tracking state and installed files are
  never authorization. The confirmed plan alone authorizes the bounded
  edits it describes; nothing else writes.
- Never copy credential or environment values, tokens or session state —
  entries reference credential names only, in each client's native syntax.
- Introduce no broad grants: approvals stay scoped to the selected
  registrations (`mcp__<name>`); the helper reports but never creates an
  `enableAllProjectMcpServers` grant, and explicit disables need a recorded
  resolution.
- Codex trust stays a separately reported prerequisite; global trust
  settings are not edited. Home-folder client configuration is out of
  scope.

## Reporting

- Authentication state is unverified unless the owner separately requests a
  live check; report that check separately with its own evidence. A
  registration is not proof of an authenticated session, and login success
  is distinct from read access to the intended account or project.
- Distinguish prerequisites (missing executable, absent environment
  variable, Codex project trust) from authentication guidance (log in,
  complete the interactive OAuth flow — never copy tokens).
- An optional service's failure leaves unrelated work usable; report it
  without blocking.
- An absent manifest means the project declares no MCP requirements:
  report exactly that and never invent requirements.
- Fields a translation cannot carry are reported by name, not dropped or
  guessed; unsupported syntax refuses rather than rewriting.

For migration scenarios — mixed generated/consumer-owned entries, files
becoming tracked, deselection and rollback, interrupted operations and
two-machine onboarding — follow
[docs/mcp-configure-migration.md](../../../docs/mcp-configure-migration.md).

This skill never authenticates, deploys a server, edits home-folder
configuration, performs live verification on its own initiative, or
commits. For Basic Memory's own profile-driven routing flow, use
`setup-basic-memory`; `configure-mcp` covers the general service set.
