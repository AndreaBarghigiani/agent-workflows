# Native Basic Memory project configuration

Setup installs `setup-basic-memory` and writes local routing instructions. The agent
uses its client's native MCP connection; this library does not implement a
memory transport, file backend, queue, replay system or hook.

## Files

- `.agents/memory/config.toml`: reviewed project routing, schema version 2.
- `.agents/memory/config.md`: generated instructions the agent reads.
- `AGENTS.md`: a short reference to that file.
- `.agents/skills/`: `setup-basic-memory` from this library. Basic Memory's own
  skills are [installed from upstream](upstream-skills.md), not by this setup.

Memory setup uses the same installation preflight as the selected workflow
refresh. It removes only an exact recognized legacy worktree policy block;
customized, malformed or duplicated blocks are preserved for a reviewed edit.
The harness owns workspace binding and lifecycle; see the
[fresh checkout guidance](../worktrees.md).

The memory folder is ignored by default. The user can choose to share its
configuration using `--share-config` or a reviewed ignore edit. Setup never stages
or commits. Existing tracked instruction and ignore changes remain visible to Git.

## Routing input

```toml
schema_version = 2

[project]
id = "example-app"

[memory]
write_project = "example-app"
search_projects = ["example-app", "shared-engineering"]
related_projects = ["example-api", "example-editor"]
mcp_server = "basic_memory"

# Optional: generate git-ignored project-scope client connections (opt-in).
# [connection]
# clients = ["claude", "codex", "opencode"]
```

Use an existing Basic Memory project identity, not a guessed folder name. A
memory scope is a project name or, on Basic Memory 1.0 and later, a
`workspace/project` qualified name; `project.id` stays a plain name. Setup
keeps the reviewed value as written and never rewrites one form into the other. The
write project comes first in the default read list; related scopes are separate
and require a task-specific reason. Each client maps its configured MCP server
name to the same Basic Memory service. Different local names can use different
local config inputs. No `backend`, `file_root` or NAS mount is needed.

The optional `[connection]` table opts the consumer into generated
project-scope connection files for the listed clients; the endpoint and
credential reference come from the machine-local connection profile, never
from routing. See [project-scope client connections](connections.md). Without
the table nothing is rendered and behavior is unchanged.

Once routing is configured, agents use those scopes without asking the user to
choose a project again. Pass the project explicitly on scoped tools rather than
changing or trusting the service default. Missing, contradictory or out-of-scope
routing needs clarification. Routing identifies a destination; it does not grant
permission to write. A memory note does not replace this checkout's routing.

Run from the consumer's worktree root using its reviewed library:

```bash
node .agent-workflows/bin/agent-workflows.ts setup_memory --project . --portable <reviewed-config.toml>
node .agent-workflows/bin/agent-workflows.ts setup_memory --project . --check
```

This helper installs `setup-basic-memory`. It does not install Basic Memory's
own skills; follow [installing Basic Memory's skills](upstream-skills.md) after
setup. Workflow adoption and the optional memory choice are described by
[`setup-agent-workflows`](../../.agents/skills/setup-agent-workflows/SKILL.md);
memory can also be added later with
[`setup-basic-memory`](../../.agents/skills/setup-basic-memory/SKILL.md).

The check prints routing and verifies artifacts/links; it does not prove MCP
connectivity. A failed check names the exact artifact — the routing file, the
generated instructions, the managed `AGENTS.md` block, the ignore entry or a
skill link — and either prints the deterministic repair command or identifies
the reviewed input still needed (a `--portable` routing file or a
customization decision). A local artifact failure is not evidence about
Basic Memory connectivity. Verify native project-scoped search and read-back
separately. Without the `[connection]` opt-in, setup
does not change client connections, credentials, hooks or remote server data;
with it, setup renders only the git-ignored project-scope files described in
[connections](connections.md) — never home-folder configuration.

Custom configuration and policy are preserved for a reviewed edit rather than
silently overwritten. Existing issue skills and local overrides stay selected.
Each worktree has its own local configuration; cloning Git does not configure its
client connection. For an opted-in consumer the worktree setup action renders
the connection files from the machine profile; see
[project-scope client connections](connections.md). The
[migration guide](migration.md) covers v1 consumers.

Setup recognizes the exact previous generated v2 instructions, including the
text generated while the library vendored Basic Memory's skills, and replaces
them on a normal run. `--check` reports the stale file
by name without changing it. Other instruction edits remain customized
and require explicit review. Client connection setup is described in
[project-scope client connections](connections.md) and in the
[Codex](../codex.md), [Claude Code](../claude.md) and [OpenCode](../opencode.md)
guides, under the shared [connection reference](../../.agents/skills/setup-basic-memory/references/client-connection.md).
