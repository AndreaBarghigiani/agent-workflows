# Agent workflows

Shared development procedures for independent projects, including monorepos and standalone libraries.

- Keep `shape-issue`, `deliver-issue`, `implement-issue`, and `review-issue` separate.
- Skills live in `.agents/skills`; Codex model profiles live in `.codex/agents`.
- Consumer product rules and commands belong in that project's `AGENTS.md`, context, and engineering docs. Shared skills must not assume a database, framework, monorepo, deployment target, or product identity.
- Keep instructions focused enough for bounded Luna implementation. Put conditional detail in supporting references.
- Preserve existing authorization. Installing a workflow never authorizes tracker edits, publishing, deployment, remote data changes, or messages.
- On Node.js 22.18 after `npm ci`, validate changed skills with `node scripts/validate.ts` and run `npx tsc --noEmit` plus `node --test` when changing installation behavior.

<!-- agent-workflows:collaboration:start -->
## Working with the owner

The owner is a software engineer who edits the working tree and commits
concurrently.

- Re-check `git status` and `git log` before verifying or completing
  anything; treat committed owner changes as the design contract, not drift.
- Keep tests green as the contract for owner edits: update tests to the
  new design when intent is clear, and ask targeted questions when it is not.
- Challenge the owner when evidence contradicts a decision. Agreement is
  not the goal; disagreement is a learning signal for both sides.
- Default to the repository's integration branch only for mechanical
  chores (submodule bumps, generated-file re-syncs, lockfile refreshes);
  use a branch and pull request for anything else, and state the
  branching choice before committing when it was not explicitly
  requested.
- Before extending work into another project, identify the destination and
  benefit, then offer both a handoff prompt for a dedicated session (the usual
  preference) and continuing here with explicit authorization for that project
  and change. Wait for the owner's choice before editing there or launching
  another session or delegate to do so; preserve authorization already given.
- Use the harness's selected project, or the session's starting repository and
  agreed task scope, to identify the project boundary. Access, shared memory,
  similar structure, and changing directories do not expand authorization.
  Respect the harness's workspace binding and preserve existing work.
  Editing a submodule's source is distinct from updating its consumer pin.
  When cross-project work is authorized, read the destination's instructions
  and check whether the change fits its implementation.
<!-- agent-workflows:collaboration:end -->

<!-- agent-workflows:reference-only:start -->
## Shared, not installed

Some one-shot setup skills stay in the library instead of being installed
into `.agents/skills`. Discovery depends on this pointer existing. Read
their instructions at the pinned revision; the library's
`docs/skill-distribution.md` defines the distribution policy.

- tailscale-web-dev: `.agents/skills/tailscale-web-dev/SKILL.md`
<!-- agent-workflows:reference-only:end -->
