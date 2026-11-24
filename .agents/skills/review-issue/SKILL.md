---
name: review-issue
description: Independently review a GitHub issue's implementation, PR, or local diff against acceptance criteria, project boundaries, and verification evidence. Use for delivery review, not implementation or feature planning.
---

# Review an issue

Read the consumer project's root `AGENTS.md`, relevant engineering/architecture docs, originating issue and parent/blockers, and actual PR or local diff. Treat the implementation handoff as claims to verify against code and observed checks.

Use the service guidance and target context supplied by the coordinator. For this library's GitHub issue workflow, configured `gh` is a prerequisite; when the review needs GitHub reads, use the explicit repository and a targeted safe read. A signed-out browser alone is not a blocker. Recheck access if the review execution context differs from implementation and report precise gaps without changing authentication.

Assess correctness, regressions, product boundaries, ownership/security constraints, and acceptance criteria. Distinguish missing implementation from missing verification. Do not edit code or mutate GitHub during a review-only assignment.

Discover applicable lint and format validation from the consumer's root and path-specific `AGENTS.md`, project documentation, and tooling configuration; confirm the supplied commands and scope against those sources. Independently run the required validation on the reviewed revision using read-only commands without autofixes, formatting writes, or installs. Implementation evidence does not replace this reviewer execution. Follow [consumer check guidance](../../../docs/consumer-checks.md) for discovery and evidence. If only a writing command is documented, resolve the supported read-only equivalent from existing tooling documentation/configuration; if unavailable, report the gap. Run other focused safe local checks when they resolve a concrete risk. Reuse your own review evidence only when the relevant revision and verification inputs are unchanged.

For changes involving dead code, dependencies, duplication, complexity, or architectural boundaries, include an advisory Fallow pass when a local or project-pinned installation is available. Read [the Fallow review reference](references/fallow-review.md) for command selection and evidence handling. If unavailable, report that limitation and continue the code review; installation and autofixes are separate actions. Fallow findings require confirmation against code and entrypoints and do not replace correctness/security review.

Use a fresh reviewer context when available and permitted. Disclose when review was performed by the same agent; never claim independence solely because a second pass was requested.

End with substantive sections compatible with the existing issue handoff hook:

- `## Issue`: issue and scope reviewed.
- `## Findings`: severity-ordered actionable findings with file references, or explicitly none.
- `## Acceptance criteria`: met, partial, or missing criteria with evidence.
- `## Verification`: exact commands and execution context, results/exit status, reviewed revision and scope, reported evidence assessed, and skipped/unavailable checks with reasons; distinguish no configured tool from configured but not run; include Fallow's outcome or why it was skipped.
- `## Closure recommendation`: recommend verified approval or closure only when every required outcome and mandatory check passes, and then include the draft outcome comment from the Issue record section; failed or unperformed mandatory checks prevent verified approval; otherwise reference partial delivery and keep incomplete parents open.

## Issue record

When reviewing work against a GitHub issue, the reviewer does not post to the issue. Only after the required acceptance criteria and mandatory validation pass, include a draft verified outcome comment under `## Closure recommendation`. The draft is the durable account of the work and should be useful source material for the pull request description. Summarize the outcome, implementation approach, important decisions, and verification evidence. Keep it concise and grounded in the diff and observed checks; do not copy an unverified implementation handoff.

The coordinator posts that one comment after checking the reviewer's evidence. For a standalone review, the user or invoking session is the coordinator. If findings remain, report them through the review handoff without a draft; the coordinator resolves them, requests re-review, and posts only after a verified result. Do not create a separate review document in the repository.

The coordinator's comment is limited to the reviewed issue. It does not authorize issue edits, labels, status changes, closure, pull request edits, merge, deployment, unrelated remote data changes, or messages.

## Basic Memory

Use Basic Memory for project knowledge that is likely to guide future work, such as durable decisions, architecture, or reusable implementation patterns. Search the relevant project memory during review when available. Capture new knowledge only when the issue reveals something reusable; do not create a Basic Memory note merely to duplicate the issue's verified implementation record. Use Basic Memory's `memory-schema` skill, when the project has installed it, and applicable Basic Memory schemas for structured notes. Relate captured knowledge to the GitHub issue when possible. The issue workflow authorizes writing this reusable project knowledge to the configured Basic Memory project; report when access or project routing is unavailable.

Review does not authorize code edits, issue comments or edits, labels, status changes, closure, pull request edits, merge, deployment, unrelated remote data changes, or messages.
