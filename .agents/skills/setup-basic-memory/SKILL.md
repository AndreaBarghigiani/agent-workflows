---
name: setup-basic-memory
description: Configure or verify a consumer project's native Basic Memory routing, and check that Basic Memory's own skills match the server's release. Use after workflow installation or independently when enabling memory later; it does not configure client connections or deploy the service.
---

# Set up Basic Memory

Configure native Basic Memory for an existing consumer installation. Read the
consumer root `AGENTS.md`, the recorded capability choice in
`.agent-workflows-capabilities.json`, and
[`configuration contract`](../../../docs/memory/configuration.md). Preserve
existing routing, generated instructions, installed skill links, local overrides,
client settings, and unrelated work. If a setup was interrupted, continue from
the established choice and artifacts; do not ask the owner to repeat a choice
that is already recorded.

Confirm the project identity, read scopes, write scope, and each client's MCP
server mapping from existing configuration or explicit choices. Do not guess a
project from a directory name, trust or change a service default, or infer write
authorization from routing. All client server names must map to the same intended
Basic Memory service. Read the guide for each selected client: [Codex](../../../docs/codex.md),
[Claude Code](../../../docs/claude.md), or [OpenCode](../../../docs/opencode.md).

Use the consumer's reviewed `setup_memory.ts` helper to link this skill and
write local routing artifacts. The
helper is noninteractive: it refuses to run when no Basic Memory choice is
recorded and refuses when the consumer's
`.agent-workflows-capabilities.json` records `declined`. To enable memory
later on an existing consumer, first record the reviewed choice with
`node .agent-workflows/bin/agent-workflows.ts install --project . --memory enabled`,
then run setup. Never pass `--skills`. Provide a
reviewed v2 TOML input only for initial setup; an existing config takes
precedence. Run the helper's `--check` after setup. It performs local work
only and does not call MCP.

Basic Memory's own skills (`memory-notes`, `memory-capture`, `memory-continue`,
`memory-schema`) are not part of this library. Read
[installing Basic Memory's skills](../../../docs/memory/upstream-skills.md) and
check the project's `skills-lock.json` for those four skills and the upstream
ref they were installed from. Report each as installed, missing, or installed
with no recorded ref. Compare the ref with the server's release when that
release is known; report a mismatch as a stop, and an unknown release as
unverified. Installing or replacing them runs an external installer and writes
project files, so do it only when the owner asks. Tool names and arguments come
from the deployed tool schemas and differ between releases; see the
[compatibility contract](../../../docs/memory/compatibility.md).

Use the [standard schema definitions](references/basic-memory-schemas.md).
Inspect the `Decision` and `Pattern` schemas in the configured project using the
client's native MCP tools when available. Read existing definitions before any
change; preserve project-specific schemas and report differences for
reconciliation. Creating a missing schema is a remote write and requires existing
explicit write authorization for that project. Use the upstream `memory-schema`
skill, when installed, once creation is authorized. If MCP access is unavailable, report local installation separately
from unverified memory connectivity. If write authorization is absent, report
schema creation as incomplete and leave existing remote data untouched.
After schema read-back, validate existing notes of those types in the configured
project when such notes are available. Keep validation in `warn` mode;
validation does not authorize schema or note writes. Report four outcomes
separately: no schema defined, a schema with no notes of that type, notes that
fail validation, and a check that could not run. A server that refuses
validation because no schema exists is reporting a missing schema, not a
validation result.

Verify local routing and selected links with the helper's `--check`. A failed
check names the exact artifact (routing file, generated instructions, the
managed `AGENTS.md` block, the ignore entry or a skill link); deterministic
repairs are printed as commands, while missing routing requires a reviewed
`--portable` input and customized artifacts a reviewed decision. A local check
failure is not evidence about MCP connectivity. Verify
project-scoped MCP access and schema read-back separately when the client exposes
the tools. Do not claim memory readiness from installed files alone. Report each
unavailable check and its reason; an incomplete memory result does not undo a
valid workflow installation.

Inspect each selected client's effective MCP configuration and exposed tools
before any change. Reuse a matching connection, refuse a conflicting one, and
configure a missing one only with explicit authorization for that client, scope,
server name, and endpoint, following the
[client connection reference](references/client-connection.md). Discovery belongs
to setup and troubleshooting; routine memory work and updates do not repeat it.

When the reviewed routing input opts in with `[connection] clients = [...]`,
`setup_memory.ts` renders git-ignored project-scope connection files
(`.mcp.json`, `.codex/config.toml`, `opencode.json`) from the machine-local
connection profile — endpoint plus credential env-var name only — manages the
ignore entries, and its `--check` reports drift, shadowing and missing
prerequisites. `setup_memory_connections.ts` regenerates the same files in
any checkout and is the command a consumer's T3 worktree setup action composes.
See [project-scope client connections](../../../docs/memory/connections.md);
the profile and client approvals stay owner-managed, and home-folder
configuration is inspected and reported, never edited.

For legacy hooks or policy, preserve all state and follow the specific
[`migration procedure`](../../../docs/memory/migration.md) before setup. Routine
library refreshes belong to `update-agent-workflows`. Client MCP configuration
changes happen only under the authorization described above. This skill never
authenticates, changes service authentication, deploys a server, writes unrelated
notes, stages, or commits.

For Claude consumers, pass `--claude-skills` to both the `setup_memory.ts`
setup and `--check` commands to mirror this skill into `.claude/skills`.
This is separate from the toolkit installer flag and does not configure MCP.


Use the shared [installation and Basic Memory readiness reporting contract](../setup-basic-memory/references/readiness-reporting.md) for handoffs. Report observed local and live evidence separately; an update requires no live memory probe.

For Claude memory connection scope, fresh-session project reads, and an
authorization-aware connection handoff, follow [Claude Basic Memory guidance](../../../docs/claude.md#basic-memory-connection-and-verification). Keep discovery, local routing checks, and actual Claude access evidence separate.
