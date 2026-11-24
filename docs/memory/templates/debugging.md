---
title: "debugging-{{capture_id}}-{{short_slug}}"
type: note
tags: [workflow-memory, debugging]
permalink: "debugging/{{capture_id}}"
workflow_kind: debugging
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

# Debugging lesson: {{specific_symptom}}

## Symptom and reproduction

Exact sanitized error text/code plus a plain-language symptom for later search.
Affected file/function, input/trigger, environment/dependency versions. Repro
command, working directory, UTC time and observed failure. Dirty paths and
sanitized snapshot reference, or explicit absence; explain provenance gaps.

## Observations and attempts

- [fact] Observed behavior with evidence reference.
- [attempt] Rejected fix/investigation, exact identifier or command, outcome, and why it failed.
- [cause] Confirmed cause and evidence distinguishing it from alternatives.
- [hypothesis] Remaining uncertainty; do not present it as the confirmed cause.
- [resolution] Effective correction and affected file/function/commit.

## Verification

Before/after command(s), working directory, UTC time, exit/results and short
sanitized output or artifact. Identify which checks were rerun and which were
supplied evidence. If causality/fix is not verified, retain a checkpoint instead
of publishing a confirmed durable debugging lesson.

## Applicability and source

Versions/conditions under which the lesson applies, counterexamples, untested
contexts, and a diagnostic check before reuse. Source note: explicit project +
identifier/path, or not-applicable for an original lesson. Shared promotion keeps
source repository/commit/issue/session/evidence and states what was generalized.

## Continuity

Supersedes: project + identifier/path and reason, or not-applicable.
Superseded by: not-applicable until corrected. Next bounded check if needed;
remaining development scope belongs in the GitHub issue.
