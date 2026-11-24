---
title: "decision-{{capture_id}}-{{short_slug}}"
type: note
tags: [workflow-memory, decision]
permalink: "decisions/{{capture_id}}"
workflow_kind: decision
capture_id: "{{capture_id}}"
status: current
created: "{{utc_timestamp}}"
modified: "{{utc_timestamp}}"
source_project: "{{project_id}}"
destination_project: "{{destination_project}}"
repository: "{{repository_url_or_unknown}}"
worktree: "{{source_worktree_path}}"
branch: "{{branch_or_detached}}"
commit: "{{head_hash_or_unknown}}"
issue: "{{github_issue_url_or_not_applicable}}"
session: "{{session_reference_or_unknown}}"
---

# Decision: {{bounded_choice}}

## Context and provenance

Problem/constraint, exact affected files/functions/identifiers and versions.
Who accepted the decision and where acceptance was recorded; distinguish a
confirmed choice from a proposal. Dirty paths and sanitized snapshot reference,
or explicitly no snapshot. Explain unknown/not-applicable provenance.

## Observations

- [decision] Accepted choice, rationale, and acceptance evidence.
- [fact] Supporting observed fact and its source.
- [alternative] Rejected option, observed attempt/result where applicable, and reason.
- [hypothesis] Any untested expected consequence, kept separate from facts.

## Verification and limits

Exact command, working directory, UTC time, result/exit and artifact; or explicit
not-run with reason. Separate acceptance of a decision from proof its runtime
behavior works. State version/context applicability and when to revisit.

## Source and generalization

Source note: explicit project + exact identifier/path, or not-applicable for
an original project decision. For shared promotion, retain original repository,
commit, issue/session and evidence; explain what applies beyond that project.
Link canonical consumer architecture documentation if the choice belongs there.

## Continuity

Supersedes: project + exact identifier/path and reason, or not-applicable.
Superseded by: not-applicable until corrected. Next bounded verification or
revisit trigger; delivery actions remain in the GitHub issue.
