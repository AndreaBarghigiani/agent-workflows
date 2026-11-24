# Update procedure

Use the consumer's active checkout as the project boundary. Read its root
`AGENTS.md`, applicable path rules, engineering/check documentation, and the
current and destination library instructions. If configured, retrieve relevant
Basic Memory context using the consumer's existing route. Missing
`.agents/memory/config.md` means routing is unavailable: disclose that and
continue from repository evidence without inventing routing or writing memory.

## Plan before changing

From the consumer root, look at `git status --short --branch`, recent commits
and the parent diff, then run the plan on the pinned dispatcher:

```bash
node .agent-workflows/bin/agent-workflows.ts update plan --json
node .agent-workflows/bin/agent-workflows.ts update plan --target <sha> --json
```

Without `--target` the plan runs no fetch of its own. With `--target`, a
full commit SHA already in the library is used as is; a branch, a tag or
any other SHA is fetched from the consumer's recorded submodule URL
(`submodule.<name>.url`, else an absolute `.gitmodules` URL; a relative one
needs `git submodule init` first), so `main` means the remote's current
branch. The fetch writes no refs, does not prompt in the terminal, and
fails as a `target-unavailable` stop; a note names the URL it fetched
from. A partial clone may also download missing objects from its own
remote while the plan reads it, as any Git command does. Without `--json` it prints the same plan as text. It
reports:

- `library` and `pins`: the library path, the index and committed gitlinks,
  HEAD, any attached branch, dirty state, and whether the pin is current,
  staged for adoption, ahead or diverged. Dirty state comes from
  `git status` in the library, which runs any filter drivers you
  configured (such as Git LFS), as your own `git status` does.
- `stops`: states that are refusals rather than a refresh — a missing or
  uninitialized pin, a dirty, ahead or diverged library, an unavailable or
  mismatched target, nested submodules in the library, existing links or files the installer would refuse,
  unreadable recorded choices, or memory routing the helper cannot
  refresh. The command exits 3. Report each reason to the
  owner; do not reset, clean, stash or force past it.
- `install`: the exact `install` and `install --check` commands with the
  flags that apply to this checkout, and the reason for each decision.
- `follow_ups`: the `setup_memory`, `t3_readiness` and `memory_preflight`
  commands that apply, in order, and when each runs.
- `owner_questions`: choices only the owner makes, such as the
  delivery-profiles offer or selecting Claude. Ask them; add the flag the
  plan names only on an explicit yes. Each question carries what the yes
  would change or what would refuse it, such as the `@AGENTS.md` import a
  Claude selection adds to `CLAUDE.md`; a refusal must be resolved before
  the flag is added. Selecting Claude adds
  `--claude-skills` to both `install` commands and, for a memory-enabled
  consumer, to both `setup_memory` commands. When `.gitignore` lacks the
  memory directory entry and nothing there is tracked, the plan asks
  whether the consumer intentionally shares the directory; only on that
  answer add `--share-config` to both `setup_memory` commands, otherwise
  the helper adds the ignore entry. Existing ignore rules are never
  removed.
- `notes`: facts to carry into the handoff.

A missing memory choice or configuration is an initial-setup or enablement
route, not evidence that a pin update failed. Parent dirt alone does not
authorize discarding anything; leave it intact and plan only the isolated
pin/install edits.

## Identify and adopt the target

Use the exact reviewed commit, an explicitly requested tagged version resolved
to its SHA, or an explicitly requested latest `main`, and pass it to the
plan as `--target`. Fetching the target does not authorize adopting it.
Confirm the fetch URL the plan names is the reviewed library, and stop for
the owner if it is not. Record the old and new SHA from `pins`; a moving
branch name is not a stable record.

If the old pin predates `update plan` or this skill, read the destination copy
first with
`git -C <library-path> show <target-sha>:.agents/skills/update-agent-workflows/SKILL.md`
and its referenced procedure, and inspect the checkout state by hand against
the same refusals. Keep the old SHA available to compare old managed
templates with `git show <old-sha>:<managed-template-path>`.

When the plan is ready and the owner accepted the target, adopt it in
detached mode, which is the pin adoption itself and not a conflict
workaround, then stage the gitlink so the installer's pin verification
passes:

```bash
git -C <library-path> checkout --no-overwrite-ignore --detach <target-sha>
git add <library-path>
```

Accepting the exact target and planned changes approves the refresh and —
unless the owner asks for a local-only result — the scoped update commit; see
[commit and land](#commit-and-land). Inspect the target's `README`,
migration notes, helpers and affected templates before executing them.
Compare the old managed templates with the consumer's installed blocks and
the destination templates; identify stale generated content separately from
genuine local edits and present exact proposed edits when policy text drifted.

## Refresh

Run the plan again from the adopted dispatcher; the destination's rules now
decide the flags. A target that predates `update plan` has no plan to rerun:
follow that target's own `update-agent-workflows` procedure instead. The plan
lists instruction edits the install will make, such as the `@AGENTS.md`
import it adds to an existing root `CLAUDE.md` when `--claude-skills`
applies; show them to the owner with the rest. Once the owner accepts it, run its `install` command, then
its `install --check` command, then each follow-up in order. Never pass
`--skills` or `--portable`. The plan never passes `--memory`: a reviewed
enablement or decline transition that is part of the update is the owner's
choice, recorded explicitly with `--memory enabled` or `--memory declined`
on the `install` command (the helper refuses to overwrite a different
recorded choice); then run the plan again, since the memory follow-ups
depend on the recorded choice. Otherwise leave
`.agent-workflows-capabilities.json` untouched.

Read the installer's output rather than predicting it. A refusal or a
`--check` failure names the artifact, link or block and prints either a
deterministic repair command or the reviewed input required; it is a failure
to report and resolve, not permission to remove protection. `retired:` lines
name proven removals; `preserved:` diagnostics name same-name entries to
review with the owner. A pin update alone does not remove policy already
embedded in the consumer's `AGENTS.md`.

Follow-up results that still need the owner:

- `t3_readiness --check-routing-source` runs after the update's scoped
  commit (the plan's `after the owner commits the pin`). A pin-state refusal
  is not a routing verdict: on a local-only update report the check as
  pending and the update as unverified.
  Its printed repair (`--reconcile-routing-source`) runs only with owner
  approval and a reviewed diff.
- The TypeScript-cutover `t3_readiness` commands refuse a pin that is only
  staged, so they run after the update's scoped commit. The first `--check`
  is expected to fail with either the migration diagnostic naming the stale
  launcher or a generated-asset diagnostic directing `--configure-action`;
  continue to `--configure-action` only on one of those and report any
  other failure. Until the regenerated
  action (`t3.json` and `.agent-workflows-t3.mjs`) is committed as well,
  fresh worktrees do not bootstrap; report it as pending on a local-only
  update. The stale `.agent-workflows-t3.py` is the owner's to remove.
- When the reviewed routing opts into generated client connections
  (`[connection]`, see `docs/memory/connections.md`), `setup_memory` also
  renders the ignored connection files for the selected clients
  (`.mcp.json`, `.codex/config.toml`, `opencode.json`) and their ownership
  record, and requires the machine-local profile
  (`~/.config/agent-workflows/memory-connection.toml`) to exist and stay
  valid. Show the owner those files among the planned edits. A missing
  profile is the owner's to provide. A profile change regenerates only
  helper-recorded entries, and an update neither adds nor removes
  `[connection]`.
- `setup_memory --check` findings (connection drift, missing ignore entries,
  shadowed entries, missing Codex trust or Claude approval, routing-source
  drift) are for owner reconciliation, not silent repair. The update never
  creates, edits or reads credential values, and no live MCP probe is part
  of these commands.
- `memory_preflight` reads local files only. Any nonzero exit is a stop to
  report with the printed reasons: `incompatible` (3), `unknown` (4) or an
  error (1). Never treat `unknown` as a pass, and never guess
  `--server-release`. For a memory-enabled consumer, follow
  `docs/memory/consumer-update.md` in the library and record the previous
  pin, the installation flags and the instruction state before changing
  anything; that record is what a rollback needs.
- An update past library version 0.2.1 retires the four Basic Memory skills
  the library used to vendor. Tell the owner the project has no memory skills
  until the upstream ones are installed at the release matching its server
  (`docs/memory/upstream-skills.md`); running that installer is the owner's
  decision.
- Consumer-owned integration references stay valid after the retirement of
  `add-integration` and `use-integration` — see `docs/integrations.md`.

## Commit and land

After the install refresh and the plan's after-refresh follow-ups, approving
the exact target SHA and the planned changes authorizes the scoped
update commit: the library gitlink plus every tracked path the refresh
changed — installer-managed `AGENTS.md` blocks, a tracked routing source,
generated T3 assets and the like. Create it on the branch the consumer's
rules select for the update — its integration branch where routine pin bumps
land directly, a topic branch where a pull request is required. An explicit
local-only request stops before this commit: run the refresh and the checks
that do not require a committed pin, leave the staged adoption and working
changes for inspection, and report the update as local-only with
committed-pin verification pending.

Keep the commit scoped. Stage nothing beyond the update's own paths and
commit just them:

```bash
git add <library-path> <tracked refresh paths>
git commit --only -m "chore: bump agent-workflows to vX.Y.Z (oldsha..newsha)" -- <same paths>
```

`--only` commits the named paths' current state — the adopted gitlink, staged
new files and worktree edits — while unrelated staged work stays staged and
unrelated unstaged work stays untouched. If unrelated changes share a path
the update must commit, the update cannot be isolated: stop, name the
blocking paths and leave everything staged and unstaged for the owner.

The plan's committed-pin follow-ups run after this commit — the
TypeScript-cutover `t3_readiness` commands and `--check-routing-source`
refuse a pin that is only staged. Their approved outputs, such as the
regenerated `t3.json` and `.agent-workflows-t3.mjs` or a reconciled routing
source, are tracked follow-up changes: commit them the same scoped way
before landing. Then execute the consumer's required checks; a failed
required check — consumer lint or format validation, a helper `--check`, or
a committed-pin check — blocks landing. Keep the local commit and the
remaining diff for diagnosis and report the failure; do not roll back
unrelated work or claim success.

Land through the consumer's authorized path: push directly only where its
rules permit it and the owner authorized the push; open a pull request where
they require one. Carry the update through the authorized steps and report
any remaining check or approval — a PR awaiting review is reported as open,
not landed. After a direct push or an authorized merge, verify the remote
target branch records the intended gitlink:

```bash
git fetch <remote> <target-branch>
git ls-tree FETCH_HEAD -- <library-path>
```

Report the update as landed only when that listing shows the new pin SHA.

## Verify and hand off

After the refresh, inspect parent and submodule status/diffs and confirm the
recorded old/new SHAs, intended gitlink, derived toolkit links, reference-only
pointer and policy blocks. When tags resolve for either pin, report its version
name alongside its SHA; report the SHA alone when no tag resolves. Consumer pin
bump commits use this convention:

```text
chore: bump agent-workflows to vX.Y.Z (oldsha..newsha)
```

Replace `vX.Y.Z` with the destination version and the SHA placeholders with the
old and new pins.
Execute the consumer's required lint, read-only format, focused and mandatory
checks with their documented context and scope. Report exact commands, exit
status, revision and scope. Distinguish an unconfigured tool from a configured
check that was not run. Failed or unperformed mandatory checks leave the update
unverified and block landing. Preserve the diff and report failure; do not
roll back unrelated work or claim success. A rerun should make no further
changes and its applicable drift check should pass before calling the update
idempotent.

The handoff reports the old and new SHAs, the check results and the update's
actual state: **landed** (remote target branch verified to record the new
pin), open pull request with its remaining checks or approvals, local-only
and uncommitted, or blocked with its failed check or blocking paths.

Do not start a delegate, new session, or work in another project to avoid an
owner choice. For cross-project changes, follow the consumer's merged policy:
identify the destination and benefit, then offer both a dedicated-session
handoff and continuing here with explicit authorization. Updating a consumer
pin is distinct from editing the shared library source.
