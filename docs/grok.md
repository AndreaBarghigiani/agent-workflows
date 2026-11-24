# Grok through T3

This document is setup guidance for agents performing Grok setup through
T3 Code. It is not a consumer instruction file. Follow the shared
[client connection reference](../.agents/skills/setup-basic-memory/references/client-connection.md)
for the inspect, reuse, conflict, and reporting rules; this page supplies the
Grok-specific observations. Workflow policy stays canonical in the installed
skills. Codex agent TOML profiles in `.codex/agents` remain explicitly
Codex-specific and do not apply to Grok.

## How T3 runs Grok

- T3 Code advertises Grok as provider instance `grok` with driver kind
  `grok` — a provider entry distinct from `acpRegistry` drivers such as
  Devin. The underlying launch mechanism (native integration, API or
  CLI) was not inspected and stays unverified.
- Model and option selection happens in T3, not in Grok configuration.
  `orchestrator_capabilities` advertises the launchable models
  `grok-4.7` (Grok 4.7) and `grok-4.6` (Grok 4.6), each with per-model
  option `reasoningEffort` taking `low`, `medium`, `high` or `xhigh`
  and defaulting to `high`. Delivery profiles store exactly this
  vocabulary: `provider` is `grok`, `model` is the launchable model ID,
  and the profile `reasoning` value maps to `reasoningEffort` at launch
  — for example `"reasoning": "low"` launches with
  `reasoningEffort: "low"`. See
  [delivery profiles](delivery-profiles.md). Never assume Codex
  profiles apply to Grok and never substitute a target silently.
- Runtime modes advertised for Grok: `approval-required`, `auto` and
  `full-access`; the `auto-accept-edits` mode some drivers advertise
  was absent from this advertisement. Child permission mode is
  inherited from the parent thread by default: omit `runtimeMode`, or
  pass `"inherit"` explicitly; see
  [deliver-issue](../.agents/skills/deliver-issue/SKILL.md).
- `delegate_task` children always run in this thread's project; passing
  `target.projectId` naming another registered project is rejected, so
  a child cannot be bound to an arbitrary directory. The discovery
  probes below therefore ran in this bound checkout with the fixture as
  a subdirectory.

## Workflow discovery (runtime-verified)

Verified in two fresh Grok child sessions (`delegate_task`, shared
checkout binding, `grok-4.7`) against this checkout plus a disposable
consumer fixture inside it — a root `AGENTS.md` carrying a marker
codeword, one installed-skill symlink under `.agents/skills`, and one
reference-only pointer, all removed after evidence collection:

- Root instructions: both probes reported that their initial context did
  not contain root instructions. The marker file was in a nested fixture,
  not the bound project's root, and complete startup context was not
  independently inspected. Automatic loading at a true consumer root
  therefore remains unverified. Explicit fixture reads worked and returned
  the marker verbatim. As a precaution, delegate briefs should carry the
  applicable rules or direct an explicit `AGENTS.md` read.
- Installed skills: the probes reported a user-level startup skills catalog;
  these self-reports do not establish that every project skill was absent.
  Explicit reads through the nested consumer's symlinked layout worked:
  `.agents/skills/implement-issue` resolved through `.agent-workflows` and
  its frontmatter was read. A post-read reminder named the skill. This
  verifies readability, not automatic discovery at a true consumer root.
- Reference-only pointers: the session resolved the root-instructions
  pointer path into the pinned library through the fixture's
  `.agent-workflows` link and read the referenced skill's
  `name` and `distribution: reference-only` frontmatter — again an
  explicit read.
- Writes and commands: creating a scratch file inside the fixture and
  running `cat` on it worked under inherited `full-access` with no
  approval prompts.
- No discovery adapter was needed: the existing installation suffices
  for explicit reads, and installation behavior is unchanged.

## Configuration locations and precedence

Machine-global Grok configuration is an explicit non-goal of this
guide; nothing below was reconfigured.

- The probed sessions' opening context showed user rules and a
  user-level skills/workflows catalog, so user-scoped Grok
  configuration exists and reaches child sessions; its file locations
  were not inspected and stay unverified.
- Provider, model and reasoning selection lives in T3 (see above); no
  Grok-side configuration is required for delegation.
- Whether a Grok CLI exists on this machine, its authentication state,
  and any environment variables were not inspected.

## Basic Memory

Client MCP configuration and project routing are separate concerns:

- In both probed sessions, the only MCP server visible to the Grok
  child was `t3-code`. The configured Basic Memory server in the
  parent session was unavailable in the child — no memory tool was listed or
  callable. Whether the Grok driver supports MCP passthrough at all, or
  T3 does not expose configured servers to this driver, is unverified;
  the verified result is that Grok delegates could not use Basic Memory
  through the harness in these sessions.
- Consumer project routing (`.agents/memory/config.md` and the
  manifest's `memory.routing_source`) stays independent of any client
  connection; no working Grok-specific memory connection or setup procedure was
  verified. Other configurations may expose memory; those possibilities
  were not inspected. The [project-scope connection
  generation](memory/connections.md) does not render a Grok file — the
  generic client steps apply until a Grok integration exists, so `grok` is
  not a valid `clients` selection. Memory-enabled consumers should
  not assign capture or resume steps to Grok delegates on this
  evidence.
- A memory-declined consumer needs no Grok-side memory configuration.

## Untested

- Automatic instruction and skill discovery in a fixture bound as the actual
  consumer project root. The probes used a nested fixture and self-reported
  startup context.

- Other harnesses and standalone CLI behavior beyond the folder-trust observation below.
- Windows and macOS; this verification is Linux-only.
- `grok-4.6`; both probes ran `grok-4.7`.
- Runtime modes other than inherited `full-access`, and plan
  interaction mode.
- A full implement or review delivery; no real Grok delivery has run
  yet, so behavior on multi-step implementation tasks is untested.
- The internal effect of `reasoningEffort` values; only launch
  acceptance was verified.
- `isolation: "worktree"` children, and launches where Grok is the
  parent rather than the child.
- T3 versions other than 0.1.9; capability advertisements can differ by
  version and account.

## Evidence

- Linux validation used T3 0.1.9.
- `orchestrator_capabilities` recorded live: provider `grok` / driver
  `grok`, `canRunChildTask` and `canRunCrossProviderChildTask` true, no
  constraints; runtime modes `approval-required`, `auto`,
  `full-access`; models `grok-4.7` and `grok-4.6` with
  `reasoningEffort` ∈ {low, medium, high, xhigh}, default `high`.
- Two fresh child sessions exercised explicit fixture reads and acceptance of
  `reasoningEffort: "low"` with inherited permissions.
- A `delegate_task` call passing `target.projectId` for a registered
  fixture project returned `invalid_request` ("a local task runs in
  this thread's project"), which is also the evidence that children
  cannot be redirected to another project.

## Gaps

- In an interactive session with folder trust disabled, Grok inspection
  reported no project instructions or project skills. If project skills are
  missing, check folder trust in the interactive client, then reopen the
  session and verify discovery.
- Automatic root-instruction and project-skill discovery at a true consumer
  root remains unverified; the nested fixture established explicit-read
  support. Carry rules in briefs or direct explicit reads as a precaution.
- Basic Memory tools are not exposed to Grok children in the verified
  sessions; memory-dependent delivery steps should stay on providers
  whose MCP surface is verified.
- Whether the Grok driver supports MCP passthrough at all remains
  unknown.
