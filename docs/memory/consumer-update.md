# Updating a memory-enabled consumer, and going back

This page covers one consumer project: updating its library pin past the
removal of the vendored Basic Memory skills, keeping its skills matched to the
server, and returning to the previous working state. Upgrading the shared
server is a separate, separately authorized step; see the
[compatibility contract](compatibility.md) for its order.

Reverting a consumer cannot undo anything on the service. Notes written, an
upgraded index and a changed server release all stay as they are. Rollback
here restores the consumer's files only.

## The two changes are independent

The library update and the server upgrade do not have to happen together. What
must match is the skills release and the server release.

| Server | Library pin | Skills to install |
|---|---|---|
| Pre-1.0 | 0.2.1 or older | Nothing; the library links its vendored copies |
| Pre-1.0 | Newer | Upstream at the pre-1.0 commit `d1f5c5265254de258fd928228291c261fb4c99b6` |
| 1.0.0 | Newer | Upstream at `v1.0.0` |
| 1.0.0 | 0.2.1 or older | No working combination; the vendored copies call pre-1.0 tools |

Pre-1.0 here means 0.23.2 (tested) and 0.24.0 or 0.24.1 (upstream's
documentation). No other release has been reviewed.

So a consumer can move to the new library first and keep working against a
pre-1.0 server, then switch skills in the same window as the server upgrade.

Renaming the client's MCP connection — for example to the recommended
`basic_memory` — is likewise independent of both changes; the
[migration guide](migration.md#rename-the-connection-to-basic_memory) has the
optional, owner-authorized procedure.

## Before changing anything

Record these and keep them with the update handoff:

- the current library commit: `git -C .agent-workflows rev-parse HEAD`;
- the flags the installation uses (`--claude-skills`, `--codex-agents`,
  `--delivery-profiles`, `--share-config`);
- the recorded memory choice in `.agent-workflows-capabilities.json`;
- whether `.agents/memory/config.md` is customized. `setup_memory.ts --check`
  reports it. Copy a customized file somewhere safe; it is usually ignored by
  Git, so Git cannot restore it.

## Update

1. Adopt the target pin and refresh the toolkit with
   [`update-agent-workflows`](../../.agents/skills/update-agent-workflows/SKILL.md).
   The installer prints a `retired:` line for each vendored memory link it
   removes.
2. Run `setup_memory.ts`. It replaces unmodified generated instructions. It
   refuses a customized file and keeps it; reconcile that file by hand.
3. Install the upstream skills at the release matching the server, following
   [installing Basic Memory's skills](upstream-skills.md).
4. Run the preflight with the server's release:

   ```bash
   node .agent-workflows/bin/agent-workflows.ts memory_preflight --project . --server-release 1.0.0
   ```

   It prints a record of the pin, the memory choice, each skill's source and
   ref, and the state of the generated instructions, followed by a verdict.
5. Run both `--check` commands, then the consumer's own required checks. With
   customized instructions, `setup_memory.ts --check` keeps failing until the
   file is reconciled; that is the existing protection, not a new fault.

| Verdict | Exit code | Meaning |
|---|---|---|
| `compatible` | 0 | `skills-lock.json` records all four skills at a release reviewed with that server |
| `not applicable` | 0 | Memory is declined or no choice is recorded |
| `incompatible` | 3 | Skills and server use different tool names, or the skills are mixed. Stop: memory calls would fail |
| `unknown` | 4 | A skill is missing or has no recorded ref, no server release was given, or the skills ref or server release is not one of the reviewed ones. Stop and resolve it; unknown is not a pass |

Exit 1 is an error, such as an unreadable lock file, and is also a stop.

The preflight reads local files only. It cannot discover the server's release,
so read that on the service host and pass it in. It accepts only the exact
pairs in the [compatibility contract](compatibility.md): a newer release, even
a patch release, is `unknown` until it is reviewed and added there. It trusts
what `skills-lock.json` records; it does not read the skill files, the
`.claude/skills` links or any client's tool list. It describes the state after
the update, so it does not replace the record taken before it.

## After the files are right

Local checks do not show that memory works. Two more steps remain, and both
need their own authorization:

- **Restart each client** so it lists the server's current tools. Update any
  tool permission list that names old tools. Changing a client's MCP
  configuration is a separate decision for that client and machine.
- **Live check in a fresh session:** project discovery, a scoped search and an
  exact read. A guarded capture and recapture on a test note needs write
  authorization for that project.

Report local results and live results separately. If the service cannot be
reached, report memory as unverified, not as failed and not as working.

## Go back

Use the commit recorded before the update.

1. Remove the upstream skills:

   ```bash
   npx skills remove memory-notes memory-capture memory-continue memory-schema
   ```

   An emptied `skills-lock.json` stays behind; delete it if the project did not
   have one before.
2. Check out the recorded commit in the library, as for any pin change.
3. Run that pin's `install.py` with the recorded flags.
4. Restore the generated instructions. The older `setup_memory.py` refuses the
   newer generated text as customized.
   - If the file was unmodified before the update, delete
     `.agents/memory/config.md` and run `setup_memory.py`; it regenerates the
     earlier text from the unchanged routing.
   - If the file was customized, move it aside, run `setup_memory.py` so the
     vendored links are restored, then put back the copy saved before the
     update, not a version reconciled to the newer text.
5. Run that pin's `--check` commands.

Step 4 matters: without it the older setup stops before it links the vendored
skills, and the consumer is left with none.

Both directions rewrite `.agents/memory/config.md`. A consumer that tracks a
copy of it through T3 readiness (`memory.routing_source`) must run that
routing-source check afterwards, as in any update.

A pin of 0.2.1 or older only works with a pre-1.0 server. If the server has
already been upgraded, going back in the consumer does not restore memory;
stay on the newer library with skills matched to the server.

## What was demonstrated

On 16 November 2026, with disposable consumers cloned at `v0.2.1` and no
service involved:

| Consumer | Forward | Back |
|---|---|---|
| Memory enabled, unmodified instructions | Eight links retired, instructions replaced, preflight `unknown` until the upstream install, then `compatible` with matching releases and `incompatible` with mismatched ones | Four vendored links restored; instructions and routing byte-identical to before |
| Memory enabled, customized instructions | Links retired; setup refused and kept the customized file; preflight reported `customized` | Same as above after moving the file aside for step 4; customized file byte-identical |
| Memory declined | Nothing to retire; preflight `not applicable` | Checks pass; no memory artifacts at any point |
