---
name: implement-issue
description: Implement a bounded GitHub issue or assigned issue slice with explicit acceptance criteria, focused verification, and an evidence-based handoff. Use for implementation after scope is established, not feature shaping or independent review.
---

# Implement an issue

Read the consumer project's root `AGENTS.md`, relevant context/engineering docs, the originating issue, and the assigned scope. Use the configured Basic Memory project to retrieve relevant project decisions and patterns, and apply those that fit the issue. If memory access or project routing is unavailable, report that gap to the coordinator. Use the consumer's applicable technical skills; this workflow assumes neither a monorepo nor a particular stack. Preserve uncommitted work and follow the project's branch/commit conventions.

Use service or capability guidance resolved by the coordinator. If the task needs another service or capability, read only its matching consumer documentation and report a precise gap if it is missing or stale. For the shared GitHub issue workflow, rely on configured `gh` and the supplied repository/account context; a signed-out browser alone does not establish a blocker. Check relevant read access when needed and report when execution context changes the evidence. Do not repeat broad tool discovery or alter authentication.

Implement the assigned outcome and acceptance criteria. Do not expand into nearby cleanup or change product, architecture, schema policy, or service boundaries to make the task easier. Return consequential ambiguity or changed scope to the coordinator with the evidence and the smallest decision needed. Continue independent work that remains within scope.

Discover applicable lint and formatting checks from the consumer's root and path-specific `AGENTS.md`, project documentation, and tooling configuration. Confirm the coordinator's commands against those sources; use the consumer's execution context and required scope. Follow [consumer check guidance](../../../docs/consumer-checks.md) for discovery and evidence.

Format your changes with the consumer's configured formatter, then pass the configured lint and read-only format validation before a verified handoff. Keep formatting and fixes within the assigned scope; report unrelated failures without broad cleanup. If no formatter is configured, follow the project's documented style and report that fact. Do not install new tools or invent commands to fill a gap.

Run focused checks for changed behavior and the project's required handoff checks. For a bug, demonstrate failure and correction when a useful regression test is practical. Do not add tests that only mirror implementation or require a production mutation. Report exact blockers rather than inferred passes. Failed or unperformed mandatory checks leave verification incomplete; do not label the handoff verified. Reuse your own valid evidence only when the relevant revision and verification inputs are unchanged.

End with substantive sections compatible with the existing issue handoff hook:

- `## Issue`: issue reference and assigned scope.
- `## Delivered`: acceptance criteria completed and relevant behavior.
- `## Partial or remaining`: incomplete criteria, or explicitly none.
- `## Files`: changed paths and their purpose.
- `## Checks`: exact commands and execution context, results/exit status, checked revision and scope, and skipped or unavailable checks with reasons. Distinguish no configured tool from configured but not run; identify mandatory verification gaps.
- `## Risks`: concrete remaining risks or decisions, or explicitly none.

Do not claim independent review or close the issue on the strength of this handoff. Shipping and external mutations follow the user's existing authorization and project rules.
