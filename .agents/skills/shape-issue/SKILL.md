---
name: shape-issue
description: Turn an ambiguous outcome, bug, or large feature into a reviewable GitHub issue or linked issue drafts, or refine an existing issue's scope. Use for issue definition and decomposition before implementation.
---

# Shape an issue

Read the consumer project's root `AGENTS.md`, its project context and engineering workflow when present, relevant product/architecture docs, and related GitHub issues. Resolve the repository from its remote or project context; do not assume this shared library is the target repository.

Distinguish established decisions from proposals. Use repository evidence to resolve uncertainty; ask only about consequential missing product decisions. Architecture decisions belong in the consumer's documentation once accepted.

Draft a user-visible outcome, scope, non-goals, acceptance criteria, dependencies, risks, and verification plan. For a small bug, keep this concise. Split a large feature into linked child issues only when each child has a verifiable outcome; identify actual blockers. Use milestones or Projects according to the consumer's conventions, without inventing IDs or statuses.

Labels: list the repository's existing labels (`gh label list`) and apply those that fit, following the consumer's conventions. Create a new label only when the owner asks for it or confirms it first, with a name and description matching the existing scheme; never create labels as a side effect of drafting. When creating or editing issues is not authorized, list suggested labels in the draft instead.

Present reviewable issue text. If the request already authorizes creating or editing GitHub issues, carry out that action; otherwise provide the draft in the response. Use a structured API body or `gh --body-file` for multiline content. Do not create a parallel local task tracker.

Leave implementation to [deliver-issue](../deliver-issue/SKILL.md) or [implement-issue](../implement-issue/SKILL.md). Shaping alone does not authorize coding or shipping.

