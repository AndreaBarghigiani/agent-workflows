# Milestone orchestration detail

Conditional detail for `deliver-milestone`: assessment evidence, scheduling,
failure isolation, base revisions, and resume. The skill holds the contract;
this reference holds the procedure.

## Assessment evidence

For each issue in the milestone collect:

- current state — open/closed, labels, milestone membership, assignees;
- acceptance criteria as written and whether current code already meets any;
- dependencies: `blocked-by`/parent/sub-issue relations, cross-issue text
  references, and shared files or systems the issues touch;
- existing work: open or draft PRs, branches, linked handoffs, prior comments
  indicating partial delivery;
- project decisions from consumer docs and the configured Basic Memory
  project when routing is available.

From that, report stale scope (criteria already met or superseded), outcomes
already delivered (verified elsewhere — propose excluding them from the plan),
missing decisions (questions only the owner can answer), and a dependency
order: which issues must land first, which are independent, and which only
share files. An assessment is evidence, not authorization: publishing any of
it as GitHub comments still requires the owner's existing authorization.

## Scheduling

Order the plan by dependencies first — a blocked issue starts only after its
blocker's PR merges or the plan explicitly rebases it. Among independent
issues, serialize those whose changes overlap the same files or subsystems
enough to conflict, and parallelize the rest up to the accepted concurrency
bound. Prefer fewer concurrent issues over more: each parallel issue costs a
fresh coordinator, a separate checkout, and an integration pass.

Concurrent implementations each get their own checkout — a linked worktree or
a harness-provided checkout — so no two children edit one working tree. The
milestone caller owns integration: it defines each issue's base revision
before launch and does not treat sibling checkouts as shared state.

## Base revisions and revalidation

Record the commit each issue starts from. When an upstream change lands — a
sibling PR merges, or the owner commits directly — every issue based on the
old revision is re-evaluated: does it still apply cleanly, and does its prior
verification evidence still describe the new tree? A check that passed before
the base moved must be assessed for validity. Rebase or integrate as needed,
then rerun affected checks and obtain renewed independent review on the
resulting revision whenever integration invalidates evidence. A clean rebase
does not substitute for revalidation. Dependent issues are
re-planned against the merged result, not the originally assessed state.

## Failure isolation and escalation

When an issue stalls, classify it before reacting:

- Needs a decision: the coordinator cannot resolve scope without the owner.
  Pause that issue, keep dependent issues blocked, continue independent ones.
- Failed verification: checks fail or review finds actionable findings. The
  per-issue coordinator runs bounded fix passes inside `deliver-issue`; the
  milestone caller only escalates when the failure is a plan-level departure.
- Environment or access failure: missing tool, denied access, undeliverable
  model. Report the exact gap; do not substitute silently.

Escalate to the owner when the departure is material: scope changes, different
roles or models than the accepted plan resolved, concurrency beyond the
accepted bound, a milestone issue that turns out to need reshaping, or a
failure pattern that makes the completion target unreachable. Escalate with
the evidence and the smallest decision needed.

## Nested delegation limits

The default topology is milestone caller → per-issue `orchestrator` child →
`deliver-issue`'s implementer and reviewer grandchildren. Orchestrators do not
recurse: a per-issue coordinator follows `deliver-issue` and delegates only
its implement and review roles — it never launches another orchestrator.
Before relying on
it, check the harness's delegation surface for child launches (for example,
T3's `orchestrator_capabilities` child-task availability). When the harness
cannot launch a child from this session, or launched children cannot delegate
further, disclose the limitation and resolve an alternative with the owner —
typical fallbacks are sequential direct `deliver-issue` runs by the caller
itself, or per-issue handoffs the owner launches manually. The report must
describe the topology that actually ran.

## Resume

An interrupted milestone resumes from observed state, never from the plan
alone. Reconcile before launching anything:

- repository state: current branch, merged PRs, existing worktrees and
  in-flight checkouts;
- GitHub state: issue status and comments, open/draft/merged PRs per issue,
  the verified comments `deliver-issue` posts;
- the accepted plan's remaining boundary.

Skip an issue only when its accepted completion target is satisfied and its
evidence remains current. A posted verified comment alone is insufficient:
if interrupted after the comment but before PR preparation, resume the missing
PR steps until an independently verified PR is ready for merge. Adopt in-flight
PRs rather than opening duplicates, and never repeat an assessment or verified
comment that already exists. Where observed state contradicts the plan —
merged work the plan didn't expect, closed issues, new upstream changes —
re-assess the affected issues before continuing.
