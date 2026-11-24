# Client connection setup for Basic Memory

Use this reference only during setup or connection troubleshooting, after the
local routing check in `setup-basic-memory`. Routine memory work and workflow
updates never run these steps. Client-specific commands and reload rules are in
[Codex](../../../../docs/codex.md), [Claude Code](../../../../docs/claude.md#basic-memory-connection-and-verification),
and [OpenCode](../../../../docs/opencode.md).

## Generated project-scope connections

When the reviewed routing input carries `[connection] clients = [...]`,
`setup_memory.ts` renders git-ignored project-scope connection files from the
machine-local profile (`$XDG_CONFIG_HOME/agent-workflows/memory-connection.toml`)
and `setup_memory_connections.ts` regenerates them in any checkout — see
[project-scope client connections](../../../../docs/memory/connections.md).
That path performs the inspection, conflict refusal, ignore management and
shadowing detection below automatically for Claude `.mcp.json`, Codex
`.codex/config.toml` and OpenCode `opencode.json`; it never touches
home-folder configuration. The manual procedure in this reference still
applies to non-opted consumers, other scopes (an owner-approved shared user
entry), other clients and harnesses (Devin inherits the T3 servers; Grok
follows the generic steps until integrated), and troubleshooting the shadowing
the check reports.

## Inputs

Take the server name, project scopes, and service endpoint from
`.agents/memory/config.toml`. The `mcp_server` value is the name every client
uses; keep it even when it differs from the shared example (`basic_memory`).
Do not rename an existing connection; renaming is a separate owner-authorized
migration covered by the
[migration guide](../../../../docs/memory/migration.md#rename-the-connection-to-basic_memory).
The endpoint and authentication mode must come from the consumer's reviewed
deployment notes or the owner. Never infer them
from another machine, client, or a default. A mounted share does not prove that
the endpoint is reachable.

## Inspect before changing

Inspect configuration offline before running any client command that connects to
servers. Read only the applicable configuration files with a local parser; never
print entire files or raw client `get`, `list`, or debug output. Allowlist output:
server name, source path/scope, enabled state, transport, and whether the endpoint
matches the reviewed endpoint. Compare URLs in memory; omit userinfo, query,
fragment and path from displayed URLs because they may contain credentials.
For launch commands, compare locally and report match/mismatch without arguments.
Report authentication reference names only, never header or environment values.

Resolve the winning entry using the client guide's precedence, including launch
flags and managed policy. If a layer cannot be inspected or precedence cannot be
resolved, classify it as unreadable and stop before probing or adding. Review all
inherited authentication fields as well as the endpoint. Only after destination
and credential references are approved may a native call probe the selected
server. Avoid all-server health checks; if a client cannot target one server,
defer the probe to a session exposing only reviewed connections.

Then classify the result for the recorded server name:

1. **Reusable:** an entry with that name points to the intended endpoint. Keep it
   and preserve its scope, name, headers, and authentication references.
2. **Conflicting:** the name exists with another endpoint or launch command, or the
   same endpoint appears under a different name, or a higher-precedence scope
   shadows the intended entry. Stop. Report the scope, endpoint, and precedence
   evidence and ask for a decision. Do not overwrite, redirect, or delete it.
3. **Missing:** no effective entry with that name. Continue to the authorized
   add step below.
4. **Unreadable:** the client cannot report its configuration. Report it as
   unverified and do not add a second entry.

Show only names, scopes, and endpoints. Never print tokens, headers, or
environment values. Reference an authentication source by name, such as an
environment variable, and let the client read it at runtime.

Run the inspection again immediately before any change. Clients differ in what an
add command does with an existing name: a check is the only reliable guard.

## Add a missing connection

Adding an entry changes client configuration. Proceed only with explicit owner
authorization for that client, scope, server name, and endpoint. Workflow
installation, a pin update, or a passing local check does not authorize it.

- Choose the narrowest scope the owner accepts and record the reason. Use a
  project or repository scope only when the configuration may be shared with that
  checkout; use a user or global scope only for an owner-approved connection
  shared across projects. Never move or copy an existing entry to another scope.
- Use the reviewed endpoint or launch command and the client's documented flags.
  Check syntax with the installed client's `--help` before running it.
- If authentication is needed, reference the credential by the client's
  environment-variable mechanism, never its value, and quote the argument so the
  shell does not expand it: Claude `-H 'Name: ${VAR}'`, OpenCode `{env:NAME}` in a
  header, Codex `--bearer-token-env-var`. Use a variable name the client does not
  treat as its own credential. Do not run an OAuth or login flow unless the owner
  asked for it.
- Record the exact command or edit, the scope, and the server name in the handoff.

Repeated setup must find the entry from the inspection step and reuse it. Do not
add a second entry under another name, and do not re-add an existing name. Same-name
behavior differs by client and is recorded in each guide: Codex `add` overwrites
silently, Claude refuses a same-scope duplicate, and OpenCode's `add` is unverified
and uses the managed service. For an existing name, the fix is an owner-authorized
edit or removal, not a second add.

## Machine, container, account, and client boundaries

A connection belongs to the client installation, the operating-system account,
and the configuration scope on one machine. It does not transfer to another
machine, container, user account, or client, even when the endpoint is the same.
Each client needs its own dependencies, network access, and credentials. A
connection in one client, such as a desktop app or another harness, is not
evidence for the Claude Code CLI, Codex, or OpenCode.

## Reload

Start a fresh session of the client after a configuration change; a running
session may keep the old tool list. Confirm that the session exposes the intended
server's tools. Each client's reload behavior is in its guide, and a client that
does not expose a reload command needs a restart.

## Verify access

Live access is a native, read-only request explicitly scoped to the intended
memory project and read scope. Use the configured write project or a configured
search project, and pass the project on the tool call. A known permitted note is
the strongest evidence. A successful query with no matching notes counts as
access. Do not create notes, schemas, or test writes to check connectivity.

Discovery steps are not access evidence. A server listed as connected proves
that the client reached the endpoint at that moment, not that the memory tools
work for the project. Record the client, version, machine, scope, tool, project,
read scope, and actual outcome.

## Report separately

Report these results separately, using the
[readiness reporting contract](readiness-reporting.md):

- **Local:** `setup_memory.ts --check` and the installed skill links.
- **Configuration:** the inspected entry, its scope, the endpoint, and whether a
  change was made or deferred.
- **Live:** the native read result, or the exact reason it was not run.

Missing authentication, an unreachable endpoint, or unavailable tools leave
readiness incomplete. Give the next step: the authorization needed, the endpoint
to confirm, or the session to restart. A failed read records the actual error.

## Discovery and declined memory

Use discovery (listing servers, tools, or skills) only during setup or
troubleshooting. Routine memory operations use the already configured tools
without repeated discovery. If memory is declined, do not inspect or change client
MCP configuration, probe the endpoint, or report connection status.
