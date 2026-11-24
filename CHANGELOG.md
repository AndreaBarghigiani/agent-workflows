# Changelog

All notable changes to agent-workflows are documented here. This project uses
semantic versioning; see [Release versioning](docs/skill-distribution.md#release-versioning).

## [Unreleased]

## [0.6.1] - 2026-11-23

Recognize untouched v0.4–v0.5 connection routing as stale.

### Fixed

- Unmodified generated Basic Memory routing that opts into project-scoped client connections and was produced by v0.4.0 through v0.5.0 — whose connection paragraph named `setup_memory_connections.py` — now classifies as stale and is regenerated instead of stopping as customized; edited files stay preserved for review.

## [0.6.0] - 2026-11-20

Node.js toolkit with a single TypeScript entry point, and planned consumer updates.

### Breaking

- The toolkit now runs on Node.js 22.18+ through a single TypeScript entry
  point, `bin/agent-workflows.ts`, with one subcommand per former script
  (`install`, `setup_memory`, `setup_memory_connections`,
  `memory_preflight`, `adopt_skills`, `mcp_configure`, `t3_readiness`,
  `t3_bootstrap`, `validate`) and an optional `--json` envelope on every
  subcommand. The generated T3 bootstrap is now
  `.agent-workflows-t3.mjs` invoked as `node .agent-workflows-t3.mjs`;
  Python-era pins and launchers report explicit migration errors rather
  than running. `validate` checks this library itself and is not a
  consumer command: `yaml` is a dev dependency, so invoking it through a
  consumer install exits 1 with `ERR_MODULE_NOT_FOUND`. See
  [TypeScript cutover migration](docs/typescript-cutover.md)
  for the new commands, the bootstrap rename, the T3 action update, and
  rollback to the last Python pin.

### Added

- `update plan` on the pinned dispatcher
  (`node .agent-workflows/bin/agent-workflows.ts update plan [--target <rev>] [--json]`)
  plans a consumer pin refresh without writing, staging or checking out;
  only a requested `--target` is fetched, from the recorded submodule
  URL. It reports the pin and library state, the install flags
  and follow-up `setup_memory`, `t3_readiness` and `memory_preflight`
  commands for that checkout, the owner questions, and the refusals; it
  exits 3 when the checkout must stop for the owner. `update-agent-workflows`
  now runs the plan instead of restating the flag rules, and keeps
  authorization and owner choices in the skill.

## [0.5.0] - 2026-11-18

Portable MCP requirements, cross-client MCP configuration, and safer integration retirement.

### Added

- Optional consumer-owned `.agents/mcp-requirements.json` declaring the MCP services a project's workflows need: the [contract](docs/mcp-requirements.md) and normative [schema](docs/mcp-requirements.schema.json) cover stable service identity (distinct from client registration names), purpose, required/optional status, workflow applicability, guidance references, a portable connection description or a pointer to machine-local details, credential env-var names and a bounded read-only verification expectation — never values, machine paths or observed status. `scripts/mcp_requirements.py` validates manifests and evaluates readiness against caller-supplied machine descriptors; `scripts/validate.py` checks a root manifest when present and install/update preserve the file byte-for-byte.
- The `configure-mcp` skill and `scripts/mcp_configure.py` helper: check-only inspection of a project's declared MCP requirements against Claude, Codex and OpenCode project configuration; prerequisite classification (missing executable, unverified authentication, unsupported transport, unknown inspection — never reported as missing); and — only after the owner confirms a redacted plan — bounded, idempotent edits that preserve unrelated servers, approvals and authentication references, refuse unsafe or stale transformations, and never copy credential values. Claude approvals stay scoped to selected registrations (names containing `__` are refused: Claude's grammar would read them as per-tool grants). Basic Memory checks accept consumer-owned aligned tracked entries alongside generated ones, with fresh-worktree validation and generation safeguards preserved; migration and two-machine onboarding are documented in [MCP configuration migration](docs/mcp-configure-migration.md).

### Removed

- The `add-integration` and `use-integration` skills: recording a project decision is an ordinary documentation edit and resolving project guidance and available access is ordinary agent work, so neither skill carried a distinct responsibility. On refresh, the installer retires proven toolkit-owned state only — a broken `.agents/skills`/`.claude/skills` link resolving to the retired path inside the pinned library, or a real directory matching the recorded retired content byte for byte — and reports each as `retired:`. Same-name entries it cannot prove are preserved with `preserved:` diagnostics; removal is never by name alone. Consumer-authored integration references, indexes, `AGENTS.md` pointers and client configuration are untouched, and returning to a pin that still ships the skills restores them through the normal derived toolkit. The retained target-selection, credential-protection and authorization guidance lives in [integration references](docs/integrations.md).

## [0.4.1] - 2026-11-17

Complete release preparation with readable GitHub Release notes.

### Changed

- `cut-release` prepares annotated tags and GitHub Release notes together by default, includes concrete `gh` publication and readback commands, and reports tag-only and partially published outcomes explicitly. Tagging, pushing and publication still require explicit approval; tag-only delivery remains available on request.

## [0.4.0] - 2026-11-17

Milestone delivery, portable memory connections, and safer workflow updates.

### Added

- `adopt-skills` consolidates identical third-party skill copies into `.agents/skills` with harness links and provenance, detects differing copies and later drift, and never runs vendor installers.

- Opt-in project-scope Basic Memory client connections: `[connection] clients = [...]` in the reviewed routing input renders git-ignored `.mcp.json`, `.codex/config.toml` and `opencode.json` entries from a machine-local profile (`$XDG_CONFIG_HOME/agent-workflows/memory-connection.toml`) holding the endpoint and a credential env-var name — never a value. `scripts/setup_memory_connections.py` regenerates them in any checkout (including T3 worktrees via the consumer's setup action) and `--check` reports drift, shadowing/duplicates and missing prerequisites such as the profile, Codex trust and Claude approval. Devin inherits the T3 servers; Grok follows the generic steps until integrated.
- Optional `orchestrator` role in `.agents/delivery-profiles.json` for the per-issue coordinators `deliver-milestone` launches, with documented resolution (named profile, then `default.orchestrator`, then the milestone caller when discoverable and launchable), override, availability-check and fallback rules.
- `deliver-milestone` skill: assess a GitHub milestone's issues, agree one execution plan, coordinate each issue through a fresh `deliver-issue` coordinator, and report verified outcomes; `deliver-issue` now rejects milestone targets (and conversely) and accepts explicitly inherited plan acceptance within an accepted milestone boundary.
- Grok (xAI) setup guide for T3-delegated consumers: live provider/model and `reasoningEffort` vocabulary, delivery-profile mapping, and runtime-verified discovery evidence — explicit fixture reads worked, automatic consumer-root discovery remains unverified, and the probes found no Basic Memory tools — with per-surface coverage and gaps.

### Changed

- `basic_memory` is now the recommended Basic Memory connection name in setup examples and instructions, independent of where the service is hosted. Existing `basic_memory_nas` and custom connection names remain valid and are never renamed automatically; the [migration guide](docs/memory/migration.md#rename-the-connection-to-basic_memory) documents an optional, harness-neutral rename procedure covering client entries, tool permission rules, consumer routing, reload and verification.
- `setup_memory.py` treats untouched generated instructions from a previous `mcp_server` name as stale and regenerates them; hand-edited instructions are still preserved for review.
- `install.py` enforces the detached-pin contract on a registered library submodule: it verifies HEAD against the consumer's recorded index pin, detaches a clean checkout attached at the pin in place without moving or deleting the branch, and stops before mutation on dirty state, unstaged pin differences or local commits requiring preservation; `--check` reports an attached checkout without changing it. Update guidance stages the reviewed gitlink so pin adoption stays explicit, and standalone or copied library checkouts keep their state.

### Fixed

- Milestone resume preserves completed outcomes and revalidates changed inputs before reusing delivery evidence.
- T3 checkout readiness accepts composed setup actions containing memory-connection regeneration while retaining command validation.

## [0.3.0] - 2026-11-16

Basic Memory compatibility and reversible consumer updates. This is a
consumer-breaking release: memory-enabled consumers must install matching
upstream skills when updating.

### Removed

- The vendored `memory-notes`, `memory-capture`, `memory-continue` and `memory-schema` skills and `third_party/basic-memory`. Memory-enabled consumers install Basic Memory's skills from upstream, per project, pinned to their server's release; see [installing Basic Memory's skills](docs/memory/upstream-skills.md).

### Added

- Issue shaping can apply existing labels and create new labels with explicit confirmation.
- [Basic Memory 1.0 compatibility contract](docs/memory/compatibility.md): which server and skills releases work together, and the upgrade order.
- Memory routing accepts `workspace/project` qualified names.
- `scripts/memory_preflight.py` reports a consumer's memory skills against a given server release as compatible, incompatible, unknown or not applicable, from local files only. [Updating a memory-enabled consumer](docs/memory/consumer-update.md) documents the update and the way back.

### Changed

- The installer removes broken links to the formerly vendored skills and reports them in `--check`. Skills another installer placed in `.agents/skills` are never treated as conflicts, and skills named in the library's own `skills-lock.json` are not distributed.
- Generated `.agents/memory/config.md` no longer names specific skills or tools; setup replaces the unmodified earlier text and keeps customized files for review.
- `setup-basic-memory` checks the installed upstream skills' ref against the server release and distinguishes a missing schema from a validation result.

## [0.2.1] - 2026-11-06

Safer delegation defaults and routing-drift repair.

### Added

- T3 readiness detects stale memory routing sources after migrations and reconciles them explicitly with `--check-routing-source` and `--reconcile-routing-source`, refusing unsafe, stale, or customized states and citing exact repair commands.
- Devin CLI compatibility guide for T3's ACP integration: provider and model selection, verified workflow discovery, configuration locations, and scoped Basic Memory access.

### Changed

- Delivery coordinators launch children inheriting the parent session's permission mode: `deliver-issue` states the rule directly, links to the profile reference for resolution detail, and a focused regression check guards it.

## [0.2.0] - 2026-11-06

Configurable delivery and clearer setup guidance.

### Added

- Choose implementation and review models through consumer-owned delivery profiles, with guided configuration based on live harness capabilities.
- Prepare descriptive tag annotations and optionally publish a separately authorized GitHub Release, including first publication and existing verified tags.
- Install and check the library repository itself: self-managed destinations report as `self:`, reference-only pointers apply in-repo, and capability choices can be recorded at the library root.

### Changed

- Installation and Basic Memory checks identify exact configuration gaps and provide targeted repair guidance.
- Release proposals present a descriptive heading and draft highlights alongside the proposed version.

## [0.1.0] - 2026-11-05

First versioned release of agent-workflows.

### Added

- Versioned toolkit distribution and consumer-aware update guidance.
- Readiness reporting for installation, Basic Memory, and harness integrations.
- Semantic release versioning and a changelog for named toolkit revisions.
- A `cut-release` skill for proposing versions, preparing release metadata, and creating explicitly authorized release tags.
