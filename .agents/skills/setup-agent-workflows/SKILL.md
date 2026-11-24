---
name: setup-agent-workflows
description: Inspect a consumer and install the versioned toolkit with shared policies and required check guidance. Use for initial setup or completing an interrupted setup; use update-agent-workflows for routine refreshes and setup-basic-memory for memory configuration.
---

# Set up agent workflows

Use this skill to adopt the shared workflow library in a consumer project. Inspect
the root `AGENTS.md`, library location and pin, installed skill links, reference-only
pointers, local overrides, and existing setup state before making local changes.
Preserve overrides, routing, and unrelated work. Do not change the library pin
implicitly.

Consumers do not select individual skills. The pinned library version defines the
standard toolkit: installed links and `distribution: reference-only` pointers follow
the library's frontmatter (see
[`skill distribution`](../../../docs/skill-distribution.md)). Basic Memory is one
optional capability recorded per consumer in
`.agent-workflows-capabilities.json` (`{"schema_version": 1, "memory": "enabled" |
"declined"}`); it is not a skill-selection manifest.

If the consumer is already configured, resume its established choices from the
capabilities file and existing artifacts. Missing memory configuration alone is not
evidence that the owner declined Basic Memory. When no choice has been made in this
session or existing project configuration, explain the optional capability, ask
whether to include Basic Memory, and record the answer by running the consumer's
reviewed library helper with `--memory enabled` or `--memory declined`. A decline
completes issue-only setup without requiring MCP access, memory skills, discovery
pointers, memory routing, or memory-specific guidance. If enabled, complete
installation and then invoke `setup-basic-memory`; report workflow installation and
memory readiness separately. Memory can also be enabled later on an existing
consumer.

For a first-time installation, use the consumer's reviewed library helper from its
root:

```bash
node .agent-workflows/bin/agent-workflows.ts install --project . \
  --memory <enabled|declined> --codex-agents
node .agent-workflows/bin/agent-workflows.ts install --project . \
  --memory <enabled|declined> --codex-agents --check
```

The helper derives the toolkit itself; never pass `--skills` (old selections are
rejected with migration guidance). It adds shared collaboration guidance while
preserving existing instructions and removes only an exact recognized legacy
worktree policy block. Customized, malformed or duplicate legacy blocks require a
reviewed edit. The harness owns workspace binding and worktree lifecycle; see the
[fresh checkout guidance](../../../docs/worktrees.md). Reference-only skills stay
in the library; the helper maintains their managed pointer block in the consumer's
root `AGENTS.md`, and the agent reads their instructions there at the pinned
revision when needed. When no choice is recorded and `--memory` is omitted, the
helper installs the issue-only toolkit and says so; it never enables memory
silently. An existing choice that differs from `--memory` is a reported conflict,
not something the helper overwrites.

The helper keeps a registered library submodule detached at the consumer's
recorded pin. `git submodule update --init` already produces that state;
`git submodule add` leaves the clone attached to a branch at the same
commit, which the helper normalizes by detaching in place — the branch is
preserved, never moved or deleted. A dirty checkout, an unstaged pin
difference, or local commits ahead of the recorded pin stop the helper
before any change with the required remedy; `--check` reports an attached
checkout without touching it. A standalone or copied library (no consumer
gitlink) is outside this contract and keeps its checkout state, including an
attached development branch.

For Claude Code, add `--claude-skills` to both commands. It mirrors the same installed toolkit into `.claude/skills`, the only project location Claude Code reads for skills; it is opt-in and never overwrites existing files. Claude instruction loading and the upgrade path for existing consumers are in [Claude Code setup](../../../docs/claude.md).

Delivery profiles are a separate opt-in for per-role model selection during `deliver-issue` coordination. When `.agents/delivery-profiles.json` is missing, explain that it maps the implement and review roles — plus the optional orchestrator role `deliver-milestone` uses for per-issue coordinators — to a provider, model and optional reasoning effort, and ask the owner whether to create it. On acceptance add `--delivery-profiles` to the install and `--check` commands; the helper creates the file containing only `{}`. Declining is fine, leaves the shipped agent defaults, and is not recorded. An existing file is consumer-owned and preserved byte-for-byte — valid, customized or invalid; the helper never populates, replaces or repairs it. After setup completes, explain what the file controls, that a missing or empty file uses the shipped `.codex/agents` profile defaults, and link the documented example, schema, and guided interactive flow for choosing real values in [delivery profiles](../../../docs/delivery-profiles.md).

Discover required lint and formatting checks for both issue-only and
memory-enabled consumers from their root and path-specific `AGENTS.md`,
engineering docs, and tooling configuration. Follow
[`consumer check guidance`](../../../docs/consumer-checks.md); report exact
commands, execution context, scope, conflicts, or missing declarations. Do not
install tools or rewrite consumer policy.

This library's GitHub issue workflow requires configured `gh` access. Check
`gh auth status` and a targeted read such as `gh issue view <number>
--repo OWNER/REPO` when setup needs to establish readiness; keep output free of
credential values. Report repository/account context and any read-access gap.
A signed-out browser alone is not a blocker. Do not install `gh` or change
authentication implicitly. This prerequisite does not govern other services or
capabilities the consumer documents.

If setup was interrupted, compare current files with the derived toolkit and the
recorded capability choice, then resume without replacing established choices.
Unexpected local files and links are reported to the owner; they are never
removed implicitly and never define the future toolkit. A failed `--check`
names the affected file, link or managed-block markers and either prints a
deterministic repair command or identifies the reviewed input required;
customized or malformed managed blocks always need a reviewed edit, never an
overwrite. A successful unchanged
rerun should be idempotent. Keep installation results distinct from whether
optional memory is ready; missing MCP access or schema-write authorization leaves
a precise memory setup gap without invalidating a valid workflow installation.

Offer optional T3 Code worktree setup only when no choice has been recorded.
Persist an explicit enabled or declined choice in the consumer's
`.agent-workflows-t3.json`; a decline requires no T3 connectivity. For enabled
consumers, review the consumer-specific base, profiles and memory routing source,
then use the pinned library's
[`T3 Code worktree setup`](../../../docs/t3-checkout-readiness.md) guide. Its
expected skill set is derived from the same toolkit; older configurations with an
explicit skills array are accepted but ignored. This is separate from ordinary
installation and later pin updates. Generating `t3.json` does not register an
effective project action; explain the GUI import and verify each readiness
milestone separately.

For detected legacy memory hooks, memory policy blocks, custom installation
state, or pre-toolkit `--skills`-based selections, preserve them and hand off to
the specific procedure in [`migration`](../../../docs/memory/migration.md).
Migration is not ordinary first-time setup. Routine reviewed library updates
belong to `update-agent-workflows`.

Setup creates local changes for review. It does not stage or commit, change client
MCP settings, deploy services, authorize remote writes, or perform tracker edits.


Use the shared [installation and Basic Memory readiness reporting contract](../setup-basic-memory/references/readiness-reporting.md) for handoffs. Report observed local and live evidence separately; an update requires no live memory probe.
