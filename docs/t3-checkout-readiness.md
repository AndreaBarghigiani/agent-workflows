# T3 Code worktree setup

This optional integration prepares the consumer's declared checkout inputs before
a T3 agent starts. It does not own worktree creation, relocation, removal or
cleanup. New and existing installations use the same procedure; enabling it does
not update the library pin or change the derived toolkit installation.

Ask: “Enable T3 Code worktree setup for this project.” The agent follows this
guide using the existing pinned library and its derived toolkit. Internal filenames,
command flags and the generated action identifier retain their readiness names.

## Choose once, then preserve the selection

During initial setup, ask whether to configure T3 only when neither the session
nor existing configuration establishes the choice. Ordinary installation finishes
when declined, with no T3 connectivity or memory prerequisite. Record the choice:

```bash
node .agent-workflows/bin/agent-workflows.ts t3_readiness --project . --record-choice declined
```

For enablement, first inspect the existing installation and review a JSON file
with its actual library path, base and profile selections. Do not infer a missing memory
file as a decline. The expected skill set is derived from the pinned library's
distribution frontmatter together with the consumer's recorded Basic Memory
choice, so no skills are listed here. For example, replace these
consumer-specific values:

```json
{
  "choice": "enabled",
  "library": ".agent-workflows",
  "base": "origin/integration",
  "profiles": ["issue-implementer.toml", "issue-reviewer.toml"],
  "memory": {"routing_source": null}
}
```

Older configuration files that carry an explicit `skills` array are accepted
and ignored; the derived toolkit replaces that selection. The same applies to a
legacy `memory.enabled` boolean: the Basic Memory capability choice lives only
in `.agent-workflows-capabilities.json`, which must exist before T3
preparation — an unknown choice cannot derive the expected toolkit. A legacy
flag that disagrees with the recorded choice is refused. Omit local skill
overrides from consideration; the derived toolkit reports them instead of
overwriting them. Existing regular profile overrides are permitted and
preserved. `memory.routing_source` is a preparation input only: it names the
reviewed non-secret file copied into a fresh worktree when memory is enabled.
Match the derived reference-only expectations to the pinned
skill's frontmatter and the exact installer-owned pointer in `AGENTS.md`.
The `library` path is relative to this checkout, supports nondefault locations,
and must identify its committed submodule gitlink. The index and initialized
library must agree with that pin. Make prerequisite pin changes through a
separately reviewed normal update, never by bypassing this check.

From the consumer root, using its initialized pinned library:

```bash
node .agent-workflows/bin/agent-workflows.ts t3_readiness --project . \
  --record-choice enabled --config-file reviewed-t3-inputs.json
node .agent-workflows/bin/agent-workflows.ts t3_readiness --project . --configure-action
```

Use the actual declared library path in these setup commands. The helper records
`.agent-workflows-t3.json` and generates `.agent-workflows-t3.mjs` plus a safely
merged root `t3.json` import candidate. Track these three non-secret files and
`AGENTS.md` so a fresh checkout receives them. Review the diff before committing;
setup never stages or commits. Unchanged reruns preserve choices and generated
bytes. A declined consumer can explicitly enable later using the reviewed input
file and `--replace-choice` with `--record-choice enabled`. Other changed choices
also require this explicit flag; no selection or pin is changed implicitly.

The generator preflights existing files, actions and prerequisites. It preserves
unrelated `t3.json` fields/actions, refuses customized or stale launchers and
conflicting action identities, and stops for an existing creation-time action.
It cannot observe GUI-only actions: inspect those immediately before importing,
compare with your baseline, and stop if they changed. Preserve setup behavior by
reviewing a command composition or an explicit role replacement. Do not mark
multiple actions as setup and assume they all execute. A customized composition
needs its own reviewed verification; the helper intentionally refuses to overwrite
it. Generated assets changing after a library update require an explicit reviewed
refresh, not deletion to bypass conflict protection.

## Base, pins and local routing

`base` is an available local ref, remote-tracking ref or commit that must be an
ancestor of checkout `HEAD`. Choose the integration base used for that task,
including the parent branch for a stack. Local refs use local commits;
remote-tracking refs reflect the last fetch and are not refreshed by readiness.
The harness's **start from origin** choice may fetch separately. An ancestor
check cannot prove which branch the harness originally selected when multiple
branches share that ancestor; review the harness workspace choice too. When a
stack's parent advances beyond this checkout, update/rebase through the normal
reviewed workflow rather than reset to satisfy readiness.

The root launcher checks base ancestry and the committed/index library gitlink
before initializing only that missing library submodule. It refuses nonempty
unexpected directories, symlink paths, modified `.gitmodules`, initialized wrong
pins and dirty libraries. It does not fetch a base, update a library pin or reset
an existing submodule. Git's existing transport/authentication policy applies;
failed initialization is an actionable prerequisite error, not permission to
change authentication. Other uninitialized/mismatched pinned submodules are
reported for explicit preparation; they are not repaired implicitly.

The launcher then invokes `scripts/t3_readiness.ts --prepare` from this checkout's
pinned library. The helper preflights the full derived toolkit before restoring
only missing skill/profile links and memory routing. It verifies that links
resolve to this checkout's library, preserves regular profile overrides, and
refuses conflicting/customized assets. It does not rewrite the consumer's
`AGENTS.md`; missing or customized managed pointers require normal reviewed setup.

Memory-disabled consumers need neither memory files nor MCP access. For enabled
memory, an existing `.agents/memory/config.md` is preserved. To restore an ignored
missing file, explicitly set `memory.routing_source` to a reviewed non-secret
file relative to the consumer root, available in a fresh checkout. This source
contains routing instructions, never credentials or client connection settings.
The destination must match its declared source if both exist. Symlink sources,
destinations and parent paths are refused. Other memory artifacts and client
settings remain consumer-owned; declare and prepare those separately when needed.
A local routing check does not establish runtime MCP connectivity.

When the consumer opts into generated project-scope client connections
(`[connection]` in the reviewed routing — see
[connections](memory/connections.md)), the setup action also renders them in
each worktree: the generated `.agents/memory/config.md` carries the reviewed
client selection, so one library command regenerates the ignored connection
files from the machine-local profile. The library ships the command; the
consumer owns the action, so compose it after the readiness launcher — only
the first `runOnWorktreeCreate` action executes:

```
node .agent-workflows-t3.mjs && \
  node .agent-workflows/bin/agent-workflows.ts setup_memory_connections --project .
```

Without a recorded selection the command exits doing nothing. A failed run
names the missing prerequisite — the machine profile, an ignore entry, a
conflict or shadowing. Codex inherits the main checkout's path trust for a
linked worktree through the common Git directory; only an explicit
`[projects."<worktree>"]` trust level overrides that fallback.

The opt-in selection reaches a worktree only through the tracked routing
source, so after enabling or changing `[connection]` reconcile and commit
that source — plus `.gitignore`, which carries the generated connection
ignore entries — **before** creating worktrees:

```bash
node .agent-workflows/bin/agent-workflows.ts t3_readiness --project . --reconcile-routing-source
```

A stale tracked source restores routing that predates the opt-in; the
worktree command detects the leftover ignore entries and fails with this
reconcile route rather than silently reporting no selection — the
`setup_memory.ts` repair does not apply there because `config.toml` is
git-ignored and absent in a worktree.

The declared source is a tracked copy of the generated
`.agents/memory/config.md`; keep it byte-identical. When migrations retire or
rename routing artifacts, the recorded path drifts and every fresh worktree
fails preparation. Check and repair it explicitly:

```bash
node .agent-workflows/bin/agent-workflows.ts t3_readiness --project . --check-routing-source
node .agent-workflows/bin/agent-workflows.ts t3_readiness --project . --reconcile-routing-source
```

Both commands require the library pin to match the committed consumer
gitlink. After a pin change, obtain owner authorization for its commit
before checking or repairing; a pin-state refusal leaves this verification
pending and is not a routing-drift verdict.


The check is read-only: it reports a missing or mismatched recorded source —
or a recorded path that cannot hold the tracked copy — with the exact repair
command, and the `setup_memory.ts` remedy when the generated routing itself
is absent or stale. The repair writes the named file with the exact bytes of
the current generated routing and repoints `memory.routing_source` to
`.agents/memory-routing.md` only when the recorded path cannot hold the
tracked copy: the generated destination, the reviewed `config.toml` input,
and retired v1 names `.agents/memory.toml`/`.agents/memory.local.toml` always
move, as does any git-ignored path — including `.agents/memory/` unless that
directory is shared and tracked. It preserves a conflicting relocation target, leaves any
retired source file untouched for reviewed retirement, refuses missing,
stale or customized generated routing, and never declares a `null` source —
those stay `setup_memory.ts` and reviewed-setup territory. Reconciliation
runs only on explicit invocation, is idempotent on rerun, re-runs readiness
verification, and reports what changed; review the diff and commit it
yourself. Migrations that retire routing artifacts run the same check before
completing; see [the memory migration guide](memory/migration.md).

## Import and verify separately

Issue #34 qualified the fallback in
[T3 setup actions and effective settings](t3-code-setup-actions.md): on T3 0.1.1,
`project.scripts` metadata updates read back but did not execute setup. Effective
project settings can override that metadata. Generating `t3.json` alone does not
register an action. Do not use private persistence or claim unattended registration.

In T3 Code 0.1.2, open the target project's settings, **Actions**, **Import
scripts**, then **Import from t3.json** and **Agent workflows checkout readiness**.
After import, inspect the effective action list and its settings. The generated
action has `runOnWorktreeCreate: true`, `async: false`, `runOnSettle: false` and no
preview URL requirement. GUI labels and permission scopes can differ by version;
#34 documents override resolution and the distinct GUI/MCP write permissions.

Before claiming delivery, verify these separate milestones on an authorized
disposable/pilot project:

1. Assets generated and local validation passed.
2. Action imported and present in the effective project settings.
3. Setup executed synchronously before the fresh agent began.
4. Selected skills were discovered in the fresh session.
5. Runtime MCP connectivity verified, unverified, or not applicable.

For read-only local checks, after configuration and preparation:

```bash
node .agent-workflows/bin/agent-workflows.ts t3_readiness --project . --check
node .agent-workflows-t3.mjs --check
```

The helper checks all declared prerequisites and generated definitions; the
standalone launcher's `--check` checks only its bootstrap/base/pin prerequisites.
Neither initializes, restores, rewrites, registers or executes setup. For an
explicit local preparation run, invoke `node .agent-workflows-t3.mjs`.

Troubleshoot the exact failure: review a wrong base, unavailable pin or transport;
restore a missing managed pointer through normal setup; preserve customized
routing/actions for a reviewed decision. Missing-source and routing-conflict
readiness failures name `memory.routing_source` in `.agent-workflows-t3.json`
and cite the reconcile repair (or `setup_memory.ts` when the generated
routing itself is absent). `install.ts` and `setup_memory.ts`
check failures identify the specific missing, stale, customized or conflicting
artifact and print either a deterministic repair command or the reviewed input
required. Existing consumers use this procedure
independently of `update-agent-workflows`. No rollout to other consumers or
remote memory write is implied.
