---
title: "checkpoint-{{capture_id}}-{{short_slug}}"
type: note
tags: [workflow-memory, checkpoint]
permalink: "checkpoints/{{capture_id}}"
workflow_kind: checkpoint
capture_id: "{{capture_id}}"
status: current
created: "{{utc_timestamp}}"
modified: "{{utc_timestamp}}"
source_project: "{{project_id}}"
destination_project: "{{write_project}}"
repository: "{{repository_url_or_unknown}}"
worktree: "{{source_worktree_path}}"
branch: "{{branch_or_detached}}"
commit: "{{head_hash_or_unknown}}"
issue: "{{github_issue_url_or_not_applicable}}"
session: "{{session_reference_or_unknown}}"
---

# Task checkpoint: {{task_or_issue_title}}

## Scope and checkout evidence

Bounded task/milestone; issue acceptance criterion addressed. Describe dirty
state and changed paths; reference a sanitized diff/artifact if available.
Record source client and relevant version; explain unknown provenance.

## Confirmed observations

- [fact] Exact identifier/error/file/function and observed behavior; evidence reference.
- [verification] Command, working directory, UTC time, exit/result, and meaningful output; distinguish supplied evidence from this session's checks.

## Attempts and uncertainty

- [attempt] Approach or command tried, outcome, and reason rejected/retained.
- [hypothesis] Unconfirmed explanation and smallest check that would resolve it.
- [limitation] Missing checks, evidence, environment access, or applicability gap.

## Resume action

Next single bounded action and prerequisite. Link the GitHub issue for remaining
delivery scope; do not duplicate the task backlog. List exact files/functions
to inspect and actions already authorized when known, with source reference.
Historical authorization here does not authorize the resumed session.

## References

Previous checkpoint: project + exact identifier/path, or not-applicable.
Relevant durable notes and verification artifacts with availability limitations.
