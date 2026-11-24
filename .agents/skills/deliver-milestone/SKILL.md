---
name: deliver-milestone
description: Assess a GitHub milestone, schedule its issues, coordinate standard per-issue delivery in fresh child contexts, and report an evidence-based completion summary. Use when asked to deliver a milestone; for one issue use deliver-issue, and for issue drafting use shape-issue.
---

# Deliver a milestone

This skill coordinates a GitHub milestone's issues through the standard `deliver-issue` workflow. It does not replace issue shaping or independent review, never expands milestone scope, and adds no tracker beyond GitHub. You are the milestone caller: you own assessment, scheduling, authorization, escalation, integration across issues, and the final report.

## Resolve the target

A milestone delivery needs an actual GitHub milestone. Resolve the repository — the explicit `OWNER/REPO` the consumer's GitHub guidance selects — and the milestone itself by number or exact title with a targeted `gh` read before planning. An issue is never a milestone target: when the request names an issue, including a parent issue or an issue carrying a `milestone` label, say so and suggest `deliver-issue` for it. Never silently redirect between the two entry points; `deliver-issue` applies the converse guard for milestone targets. Configured `gh` is a prerequisite per the shared GitHub issue workflow: verify relevant read access with a targeted safe read, and report precise access gaps without changing authentication.

## Assess the milestone

Read the consumer's root `AGENTS.md`, context and engineering docs, and the configured Basic Memory project when routing is available; disclose a routing gap rather than guessing. Assess every issue in the milestone against current code, its acceptance criteria, dependencies and blockers, existing PRs and branches, and relevant project decisions. Return to the owner: stale scope, outcomes already met, missing decisions, and a proposed dependency order. Publish assessment comments on GitHub only when useful and within existing authorization; otherwise report them locally.

## One execution plan

Present a single execution plan before any issue work: the issues in scope and the completion target (default: independently verified PRs ready for merge), the resolved provider, model and reasoning for each delivery role, the concurrency bound and checkout strategy, and the automatic acceptance boundary — which per-issue decisions proceed without repeated approval and which escalate. Wait for the owner's acceptance.

Resolve the per-issue `orchestrator` role through the consumer's `.agents/delivery-profiles.json` following [delivery profiles](../../../docs/delivery-profiles.md): the selected named profile, then `default.orchestrator`, then your own provider, model and settings only when they are discoverable and launchable for a child task; otherwise ask the owner for a choice before launching. Disclose the resolved selection, and check availability for the child launch before delegating — never substitute a model silently.

Within the accepted boundary each issue proceeds without repeated human approval: pass explicit inherited acceptance to each per-issue coordinator so its `deliver-issue` plan checkpoint is satisfied. A material departure from the boundary — changed scope, different roles, exceeded concurrency — stops for owner escalation, not silent adjustment.

## Coordinate deliveries

For each issue, launch a fresh child coordinator on the resolved `orchestrator` role; it follows [deliver-issue](../deliver-issue/SKILL.md) end to end, including the configured implement and independent review roles. Milestone delivery therefore requires nested delegation — caller to per-issue coordinator to implementer and reviewer. When the harness cannot launch the per-issue child, or a child cannot delegate further, disclose that limitation and resolve an alternative with the owner; never claim a delegation topology that did not happen.

Launch each child inheriting the parent session's permission mode by default: omit `runtimeMode`, or pass `"inherit"` where the launch contract supports it. Choose a narrower mode only when the owner explicitly requests supervised execution.

Schedule parallel work from the assessment: dependencies first, then overlapping changes and integration risk. Keep concurrency bounded and isolate concurrent implementations in separate checkouts so independent issues never share a working tree. Define each issue's base revision before its work starts; after an upstream change lands, re-evaluate dependent issues against the new base and revalidate any evidence the integration change invalidated. When an issue needs a decision or fails verification, block only that issue and its dependents and continue independent work where safe. See [orchestration detail](references/orchestration.md) for dependency ordering, overlap handling, failure isolation, and resume.

To resume an interrupted milestone, reconcile current repository and GitHub state first — issue status, open and merged PRs, posted comments, delivered handoffs — so resumed work continues from observed state and never duplicates a delivery, PR, or comment.

## Complete and report

Default completion means each in-scope issue has an independently verified PR ready for merge. Merging, closing issues or the milestone, and publishing releases follow existing authorization; do not perform them implicitly.

Report per issue: outcome, PR and verified-comment links, reviewed revision, required-check evidence, blockers, deviations from the accepted plan, and remaining work. Tracker mutations beyond the verified issue comment `deliver-issue` already authorizes, plus commits, pushes, merges, deployments, and messages, follow existing user authorization and project rules.
