# Migrate from custom checkpoints to native Basic Memory

This revision removes `scripts/memory.py`, `memory_mcp.py` and
`memory_lifecycle.py`, their runtime tests, and the custom capture/replay workflow.
The `workflow-memory` skill is also removed; routing lives in the consumer's
`.agents/memory/config.md`. Basic Memory's own skills are [installed from upstream](upstream-skills.md) by each project.
Existing consumers do not update themselves, and their shared notes are preserved.

## Migrate from --skills-based installations

Consumers installed with the removed `--skills` option (or any other per-skill
selection) migrate to the versioned toolkit model. The accepted model gives
every consumer the standard toolkit derived from its pinned library version,
with Basic Memory included only when enabled; there is no consumer
skill-selection manifest.

1. Never rerun the old command shape. `install.ts` and `setup_memory.ts`
   reject `--skills` with exit status 1 and this guidance:

   > --skills was removed: consumers install the standard toolkit derived from
   > the pinned library version instead of a skill selection. Rerun without
   > --skills; unexpected local files are reported, never removed.

2. Treat existing artifacts as evidence, not as the future skill list. Inspect
   existing links, local overrides and policy blocks for ownership and
   conflicts before changing anything. A partial historical selection does not
   define what the consumer should install next; the destination revision's
   distribution frontmatter does.
3. Run the normal reviewed update or setup from the consumer root:

   ```bash
   node .agent-workflows/bin/agent-workflows.ts install --project . --memory <enabled|declined> --check
   node .agent-workflows/bin/agent-workflows.ts install --project . --memory <enabled|declined> [--codex-agents]
   ```

   Record the Basic Memory choice explicitly. A decline installs no memory
   skills, discovery pointers, routing or memory-specific managed guidance. An
   unknown choice installs the issue-only toolkit and says so; helpers never
   enable memory silently. When memory should be enabled on an existing
   consumer, pass `--memory enabled` and then run `setup_memory.ts` as in the
   "Adopt and configure" section below.
4. Report unexpected local files and customized assets instead of removing
   them. Missing memory routing alone never authorizes removing an existing
   memory installation or deleting its configuration, and it never establishes
   a decline.

## Before adopting this revision

In each consumer/client, inspect all active hook sources. Remove only registrations
that call this library's `memory_lifecycle.py` marker or capture handler, preserving
unrelated handlers. Common project sources are `.codex/hooks.json`, inline
`.codex/config.toml`, and Claude settings; inspect active user-level sources too.
The new setup can detect project sources, but cannot prove global hooks are absent.
Do not remove or change unrelated client trust. Retire the hook before changing the
library pin so the client does not invoke a removed script between steps.

Retain existing `.agents/memory-pending/` and `.workflow-memory-evidence/` while
reviewing unresolved captures. Do not reset write intent or blindly resend a note
whose old write outcome is uncertain. Inspect exact existing remote notes within
authorization; unresolved cases require reconciliation. The new library cannot
replay old receipts. If an old read-only inspection is needed, use the old pinned
revision in a separate checkout, without re-enabling automatic writes.

## Adopt and configure

1. Adopt a reviewed library commit after preserving submodule edits. Inspect the
   consumer's `.agents/skills/workflow-memory` link and remove it only if it points
   to the retired shared skill under `.agent-workflows/.agents/skills/workflow-memory`.
   Preserve a regular file/directory or a link to another local implementation for
   separate review. Setup flags a leftover shared link instead of leaving it broken.
2. Remove the old marked memory policy block from `AGENTS.md` and old prose requiring
   a Stop hook, evidence wrapper or `workflow-memory-milestone`. Preserve other rules.
   Setup refuses customized/legacy blocks rather than silently replacing them.
3. Review a v2 routing example. Carry over the intended project and read scopes;
   choose the existing client-native MCP connection. No `backend` or `file_root`.
4. Run setup from the consumer root:

   ```bash
   node .agent-workflows/bin/agent-workflows.ts setup_memory --project . \
     --portable .agent-workflows/docs/memory/examples/example-app.toml
   node .agent-workflows/bin/agent-workflows.ts setup_memory --project . --check
   ```

   Use the example only for its matching project, or supply your own reviewed input.
   Generated routing/instructions live under `.agents/memory/`, ignored by default.
   Setup adds a short `AGENTS.md` reference and links `setup-basic-memory`,
   retaining existing issue skills. Basic Memory's own skills are
   [installed from upstream](upstream-skills.md). It never stages
   or commits.
5. Choose what to track. `--share-config` skips adding the memory-directory ignore;
   it does not remove existing ignore rules. `.gitignore` cannot hide tracked edits.
   Old v1 `.agents/memory.toml` and `.agents/memory.local.toml` are no longer read.
   Review any tracked copies before retiring them; keep unrelated config intact.
6. Reconcile the recorded T3 routing source. When the consumer recorded an
   enabled T3 readiness choice with memory enabled, retiring or renaming
   routing artifacts — including a tracked copy of the generated routing —
   leaves `memory.routing_source` in `.agent-workflows-t3.json` pointing at a
   missing file, and every fresh T3 worktree then fails preparation. Run the
   read-only check:

   ```bash
   node .agent-workflows/bin/agent-workflows.ts t3_readiness --project . --check-routing-source
   ```

   Both commands require the library pin to match the committed consumer
   gitlink. After a pin change, obtain owner authorization for its commit
   before checking or repairing; a pin-state refusal leaves this verification
   pending and is not a routing-drift verdict.


   On drift it prints the exact repair command; with owner approval run:

   ```bash
   node .agent-workflows/bin/agent-workflows.ts t3_readiness --project . --reconcile-routing-source
   ```

   The repair writes the tracked source with the exact bytes of the current
   generated routing and repoints `memory.routing_source` only when the
   recorded path cannot hold the tracked copy (the generated destination,
   the reviewed routing input, retired v1 artifact names, or any git-ignored
   path). It refuses missing or customized
   generated routing; those stay reviewed `setup_memory.ts` territory. Review
   its diff and let the owner commit it; do not consider the migration
   complete while drift remains. See
   [the T3 worktree setup guide](../t3-checkout-readiness.md).
7. Verify native project-scoped search/read in a fresh client session. If authorized,
   verify a uniquely owned capture and exact read-back, then retrieve the same note
   from another client. Delete only disposable test material. Installed files alone
   do not establish skill discovery or cross-client access.

The same setup applies on Linux and Mac. Connection names can differ locally as
long as they map to the same Basic Memory service and project. No NAS mounts,
custom hook commands, evidence hashes or milestone fences are required.

## Rename the connection to `basic_memory`

`basic_memory` is the recommended connection name in current setup examples and
instructions, independent of where the service is hosted. This section is
optional: existing names such as `basic_memory_nas` — or any custom name —
remain valid, nothing renames automatically, and a working connection needs no
change. A rename changes only the local name mapping; the service, its data and
its authentication are untouched. It needs owner authorization for that client,
machine and scope, and the order below matters: the connection name, the tool
permission prefix and every consumer's `mcp_server` routing must stay aligned,
so a partial rename can break access.

Every harness has the same pieces:

- **Connection entry:** a name mapped to an endpoint or launch command plus
  authentication, possibly in several scopes or layers with a precedence order.
- **Tool permission rules:** keyed by the server name or a tool prefix derived
  from it, for example Claude Code's `mcp__<server>__*`.
- **Consumer routing:** each consumer's `mcp_server` in
  `.agents/memory/config.toml` plus the generated `.agents/memory/config.md`.
- **Reload:** the client must load the changed configuration before a session
  can discover the renamed tools.

In order, per client and machine:

1. Inspect the effective configuration offline using the output allowlist in the
   [client connection reference](../../.agents/skills/setup-basic-memory/references/client-connection.md);
   record the winning entry's scope, endpoint and authentication references.
2. Add a `basic_memory` entry alongside the old one in the same scope, copying
   the endpoint or launch command and the authentication references exactly.
   Adding an entry is an owner-authorized client-configuration change.
3. Update the client's tool permission rules for the new name or prefix; keep
   the old rules until step 6.
4. In each consumer routed through that client, update `mcp_server` to
   `basic_memory` in `.agents/memory/config.toml` and in any reviewed routing
   input kept for `--portable`. Setup recognizes the untouched generated
   `.agents/memory/config.md` from the old name as stale and regenerates it. A
   hand-edited file is reported as customized and left unchanged; carry the
   edits over deliberately before regenerating. Then re-check:

   ```bash
   node .agent-workflows/bin/agent-workflows.ts setup_memory --project .
   node .agent-workflows/bin/agent-workflows.ts setup_memory --project . --check
   ```

   The regenerated instructions differ only in the server name; project
   identities and read/write scopes are unchanged. A consumer that tracks a
   copy of the generated routing through T3 readiness (`memory.routing_source`)
   reruns its routing-source check afterwards, as in any update.
5. Reload the client as its guide describes and start a fresh session. Verify
   tool discovery under the new name, a scoped search and read with the
   configured project, and — only where writes are authorized — a disposable
   write with read-back. Record the client, version, machine, scope and actual
   outcome.
6. Remove the old entry and its permission rules only after every consumer
   that uses that client on that machine has switched its routing. Removing it
   earlier breaks consumers still routed to the old name.

Rollback reverses the order: re-add or restore the old entry and its
permission rules, point each consumer's `mcp_server` back and regenerate its
instructions the same way, reload and verify, then remove the `basic_memory`
entry last.

Preserve throughout: project identities, read/write scopes, endpoints,
authentication references, custom instructions and unrelated settings.

Per-harness details live in the client guides:

| Harness | Entries, permissions and reload |
|---|---|
| Claude Code | [docs/claude.md](../claude.md): scopes and `claude mcp` commands under "Review the connection scope"; fresh-session reload under "Fresh-session read evidence" |
| Codex | [docs/codex.md](../codex.md): layered `config.toml` under "Inspect the effective configuration"; new-session reload under "Reload and verify" |
| OpenCode | [docs/opencode.md](../opencode.md): `mcp.servers` entries, precedence and `opencode reload` under "Register the connection" and "Reload and verify in T3 Code" |
| Devin | [docs/devin.md](../devin.md): the connection comes from the harness's MCP configuration, not Devin config; `devin mcp` manages CLI-side entries |
| Grok | [docs/grok.md](../grok.md): the probes found no Basic Memory tools; no working connection procedure was verified, and other configurations remain untested |

Verification records keep the names actually used: historical notes, stage
files and test outputs that mention `basic_memory_nas` or another name describe
what was observed and are not edited to the new name.

## Move a home-folder connection to project scope

Consumers that keep a user- or local-scope connection can move gradually to
the generated project-scope entries — one project at a time, never
automatically. Existing entries are detected and reported, never moved,
overwritten or deleted by the helpers.

1. Create the machine-local profile once per machine (endpoint plus the
   credential env-var name; see
   [project-scope client connections](connections.md)).
2. Add `[connection] clients = [...]` to the reviewed routing input and rerun
   `setup_memory.ts`. If an existing entry would shadow the project entry —
   a Claude local-scope entry for that path, Codex user fields the project
   layer does not set, or an `/etc` OpenCode entry — setup refuses and names
   it; reconcile that entry first. Same-endpoint duplicates are reported as
   warnings only.
3. Verify a fresh-session scoped read per the client guide.
4. Remove the home-folder entry only when no remaining project needs it —
   the rename procedure above keeps name, permissions and routing aligned
   and shows the per-client removal steps. A user who prefers the global
   connection simply does not opt in; nothing changes for them.

## What remains

Project routing, useful development provenance, honest persistence reporting and
GitHub's role as task tracker remain. Capture and resume use upstream guidance.
Native recapture synthesizes the matched thread note instead of creating immutable
checkpoints. Historic shared notes and prior verification records remain readable.

No backups, schedules, tracker edits or remote note cleanup are performed by
this migration. Native MCP unavailability is reported in the handoff; there is no
custom queue/replay engine after migration.
