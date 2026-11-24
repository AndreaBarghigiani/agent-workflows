# MCP configuration migration and onboarding

How existing consumers move to `configure-mcp` and the consumer-owned
connection model of issue #107 without losing configuration, authorization
boundaries or in-flight work. This covers both the general manifest-driven
flow ([`configure-mcp`](../.agents/skills/configure-mcp/SKILL.md)) and the
Basic Memory opt-in it interoperates with
([project-scope client connections](memory/connections.md)).

## Ownership model

Every client connection file is exactly one of:

- **Generated** — rendered from the machine-local profile, git-ignored,
  recorded in `.agents/memory/connections.json`, and governed by
  generation-equality: a file the helper wrote may be regenerated only
  while it still equals what the helper wrote.
- **Consumer-owned** — git-tracked or otherwise hand-maintained. Generation
  never writes it. The check validates it through the alignment path and
  reports the two kinds distinctly.

A registration maps to the memory service when its name equals the
routing's `mcp_server` value or the endpoint-equivalence heuristic matches
(a different registration name is preserved). It is *aligned* when the
connection structurally satisfies the service: a remote http(s) endpoint
and a credential environment-variable NAME, resolved against the machine
connection profile when available. A tracked literal endpoint is validated
structurally when no profile exists. Authentication state is never
verified by these checks — it is always reported as unverified, and live
verification remains a separate authorized action.

## Existing #100 opt-ins

Consumers that opted into `[connection] clients = [...]` in the reviewed
routing input keep that selection verbatim; it is the same input the
alignment path reads. Nothing about the generated, git-ignored path
changes: missing files render, drifted recorded entries update, and
generation-equality still governs. A consumer that never opted in sees no
new behavior and no new checks.

## Manual/generated mixtures

The two ownership kinds mix freely — per client, not per file. A consumer
may keep Claude's `.mcp.json` tracked and consumer-owned while Codex and
OpenCode files stay generated and ignored. Reports label each client's
entry as generated or consumer-owned; unrelated servers sharing a tracked
file are neither touched nor judged. The existing shadow and duplicate
checks (home-scope entries, OpenCode layers, Claude approval state, Codex
trust) run for the mapped registration name in either ownership mode.

## Stale ownership

The ignored `.agents/memory/connections.json` record describes only what
the helper generated. A recorded entry whose file becomes tracked is
released — the file is consumer-owned and the record is pruned — so the
ownership record can never be used to claim write access to a tracked
file. A recorded entry in a deselected client's untracked file still
reports as a leftover for manual reconciliation; in a tracked file it
reports as consumer-owned instead of failing.

## Files becoming tracked

This is the reported regression: a consumer opted in, then tracked
`.mcp.json`, `opencode.json`, `.codex/config.toml` and
`.claude/settings.local.json` with a manually added `basic_memory_nas`
entry alongside unrelated servers. The check now accepts that file when
the entry is verifiably aligned — endpoint matching the machine profile
(or structurally valid without one), credential referenced by
environment-variable name, no literal values, not disabled. When it is not
verifiably aligned, the check fails non-zero with a targeted alignment
instruction: what to change, in which file, to which shape. It is never a
rewrite demand and never an automatic edit.

Tracked `.claude/settings.local.json` acceptance is verified against
synthetic fixtures: they prove the *helper* reads and writes the file
correctly, not that a given client version honors the entries it
contains. Operational approval behavior for tracked settings remains
unverified until a live qualification on an authorized machine — verify
that the deployed Claude Code version honors the written
`permissions.allow`/`disabledMcpjsonServers` entries, and record the
client version plus evidence separately, per this issue's live-check
deferral.

Generation stays blocked for tracked files deliberately: a generated file
must stay git-ignored (it carries machine-local profile data and must not
hide existing project configuration), so "generate anyway" would either
commit machine-local details or overwrite reviewed content. Tracking the
file is the consumer's declaration of ownership; the helpers respect it
and validate instead of writing.

## Fresh worktrees

Inherited tracked entries are validated through the same alignment path —
never rewritten from machine-local profiles. A missing or conflicting
tracked entry in a worktree fails the setup command with the targeted
alignment instruction; a worktree that restores only ignored generated
files renders them from that machine's profile as before. Prior alignment
metadata is not reusable write authorization: no persistent alignment
metadata exists — alignment decisions are per-invocation inputs recomputed
from the routing, the files and the machine profile on every run.

## Deselection and rollback

- **Deselect a client** by removing it from `[connection] clients`.
  Recorded generated leftovers are reported for manual removal — the
  helpers never delete client configuration. A deselected tracked file
  needs nothing: it was never written by the helper, and any stale
  ownership record for it is released.
- **Roll back the opt-in** by removing the `[connection]` table. The same
  leftover reporting applies. Consumer-owned entries remain valid client
  configuration after rollback; they simply stop being checked.
- **Roll back a configure-mcp apply** by reviewing the applied plan's diff
  and reverting the bounded edits it lists — the plan records every file
  and action it touched.

## Interrupted operations

All writes are atomic per file, and every write path preflights all
destinations first: a refusal — shadowing, unaligned consumer-owned
entries, conflicts, stale plans, a destination resolving outside the
project root — happens before anything is written.

A `configure-mcp` apply is *not* transactional across destination files:
a failure partway through (for example a filesystem error between
clients) leaves earlier destinations already changed. The plan file is
written back only after a fully successful apply, so a persisted plan
still records the pre-apply digests — rerunning it refuses as stale, by
design. Recovery is to run `check`, build a *fresh* plan against the
current files (work already applied now classifies as reuse), review,
record resolutions, confirm and apply.

For the generated-file helpers, the ownership record reflects only
completed writes, so rerunning the same command resumes where it
stopped.

## Metadata and schema compatibility

No persistent alignment-metadata schema exists and none is introduced.
Alignment decisions, confirmed mappings, machine descriptors and plan
confirmations are per-invocation inputs — JSON files the owner supplies to
each command — never stored authorization and never a schema other tools
must migrate. The only persisted records remain the routing selection
marker inside generated `.agents/memory/config.md`, the generated-entry
ownership record `.agents/memory/connections.json` (git-ignored), and the
confirmed `configure-mcp` plan file the owner keeps for review.

## Which tool does what

- **`configure-mcp`** inspects the requirements manifest against all three
  clients and applies bounded, confirmed edits — it is the general
  alignment tool, including for tracked Basic Memory entries the check
  reports as unaligned.
- **`setup-basic-memory`** (and `setup_memory_connections.ts`) is Basic
  Memory's own profile-driven routing flow: it renders generated
  connection files and *validates* consumer-owned ones — it never edits
  tracked files.
- **`adopt-skills`** only consolidates skill copies; it does not inspect or
  change MCP configuration.
- **Routine installation/update** (`update-agent-workflows`) is
  configuration-preserving: it refreshes installed files and routing but
  does not create, delete or reclassify connection entries, and the check
  still runs afterwards under the same ownership model.

## Two-machine onboarding

Declare the requirements manifest (and the memory routing) once — both are
consumer-owned and portable. On each machine:

1. Create the machine-local connection profile once per OS account; it is
   never committed.
2. Run `setup_memory.ts --check` (or `setup_memory_connections.ts
   --check`) and `mcp_configure.ts check`; tracked consumer-owned entries
   validate structurally even before a profile exists, while generated
   entries need the profile.
3. Where alignment is wanted, review and apply a `configure-mcp` plan or
   edit the tracked entry per the emitted instruction.

Machine-side authentication stays per-machine: credential values, sessions
and approvals never transfer; each machine's client authenticates through
its own supported mechanism.

## Partial-completion reporting

Both tools report per client and per service what ran and what remains:
drift vs. consumer-owned-aligned vs. unknown-inspection per file, and the
specific prerequisite (machine profile, Codex trust, Claude approval) or
authorization step still open. A check result is local artifact state
only — it never asserts MCP connectivity, and an optional service's
failure leaves unrelated workflows usable.
