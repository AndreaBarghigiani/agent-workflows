---
name: reconcile-issues-after-merge
description: Reconcile GitHub issue status, acceptance checklists, parent progress, and dependencies after a pull request merges. Use after merge to record what the merged work actually completed; not for code review or issue shaping.
---

# Reconcile issues after a merge

Bring the relevant issue chain up to date with a merged pull request. Treat issue status as the completion signal and checkboxes as evidence-backed progress summaries. A merge or closing keyword alone does not prove that an issue's outcome is complete.

## 1. Confirm the merge and scope

- Identify the specific pull request and verify from the available GitHub context that it was merged. If it is open, closed without merge, or the merge state cannot be verified, stop before proposing completion updates and report that state.
- Read the merged diff, PR description and discussion relevant to delivered scope, and available verification results. Do not repeat code review; use existing review and check evidence to understand what landed.
- Find issues explicitly referenced by the PR and the relevant parent/child and dependency chain for those issues. Follow links only as far as needed to reconcile that chain. Do not inspect or edit unrelated issues.
- Read the consumer repository's `AGENTS.md`, project context, engineering workflow, and issue conventions when available. These govern tracker access, authorization, status semantics, and any required handoff. The skill itself does not grant permission to edit a tracker.

## 2. Compare evidence with issue outcomes

For each referenced issue and relevant parent:

- Read the full issue body, acceptance criteria, current state, checklists, parent links, and blocker/dependency links.
- Map each acceptance criterion to evidence in the merged change or its recorded verification. Mark a criterion complete only when that evidence supports it. Keep unchecked criteria open when incomplete or unclear.
- Distinguish an issue's acceptance checklist from a parent's child-progress checklist. A closed child issue is authoritative evidence that the child is complete; synchronize a corresponding parent checkbox when appropriate. A checkbox by itself does not close an issue or establish that a child is complete.
- Check dependencies in the relevant chain against current issue state. Remove or resolve a dependency only when that issue is complete and no remaining work depends on it. A dependency on a closed issue is stale; report or correct it according to tracker conventions. Do not remove an open dependency simply because the current PR is related to it.
- For a parent issue, evaluate its own outcome and parent-level criteria as well as its children. Do not close it solely because all child issues are closed. Keep it open while required child outcomes, parent criteria, or other blockers remain.
- If issue criteria, relationships, or the evidence do not support a clear completion decision, do not guess. State the ambiguity and the smallest human decision needed; continue reconciling independent, clear items.

## 3. Apply only authorized, supported updates

- Propose or make only changes directly supported by the merged work and the consumer's conventions. This can include acceptance checkboxes, parent child-progress checkboxes, stale dependency references, and issue status when the full issue outcome is met.
- Leave partially delivered issues open and preserve unchecked criteria and active dependencies. Do not edit milestones, labels, unrelated issues, or product scope unless the consumer's workflow calls for a change necessary to reflect this merge.
- Before editing GitHub, confirm that the consumer's instructions and the user's request authorize tracker edits. A request to run this skill or a merged PR's closing keyword is not, by itself, authorization when the consumer requires explicit authorization. If authorization or suitable editing access is absent, do not attempt an edit.
- Use any available GitHub interface or tool that can perform the needed action; do not require a particular CLI, API, plugin, or integration. If a desired field cannot be changed with available access, report that limitation and provide the exact proposed text or checkbox/status/dependency changes.

## 4. Verify and report

- After each authorized edit, reread the affected issue and verify its resulting body, status, and relevant relationship state. Do not claim an edit succeeded based only on a submitted request or tool response that lacks confirmation.
- If verification fails or the tracker result differs from the intended update, report the observed state and the exact remaining action. Do not silently retry a consequential or ambiguous change.
- Summarize the PR and merge state, issues inspected, evidence-to-criteria decisions, updates made and verified, partial work, stale dependencies, blockers, and any exact proposed edits that could not be applied.
- Clearly distinguish completed changes from recommendations and unresolved decisions. Do not claim that an issue was closed, a dependency removed, or a checklist synchronized unless the resulting tracker state was observed.

## Expected outcomes

- **Fully delivered issue:** supported criteria and relevant parent progress are synchronized; close only if the entire issue outcome is met and editing is authorized.
- **Partially delivered issue:** check only completed criteria, retain remaining work and blockers, and keep the issue open.
- **Completed child with open parent:** synchronize its parent progress entry, but leave the parent open until its own outcome and all required child work are complete.
- **Stale dependency:** identify the completed blocker and remove its dependency reference only when no longer blocking, subject to tracker conventions and authorization.
- **Unavailable access or authorization:** make no external edit; provide exact proposed updates and clearly identify what remains unapplied.
