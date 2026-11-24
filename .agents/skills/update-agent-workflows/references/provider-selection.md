# Provider discovery and selection

Use this procedure when an update request mentions harnesses, runtimes, or
providers. Provider availability is evidence for an explicit selection, not
project intent. An ordinary update preserves the consumer's existing adapters
and never enables one because it is globally available.

## Discover runtime capability

In T3 Code, call `orchestrator_capabilities` and inspect provider records and
their constraints. Report providers in three states:

- **Available:** the provider instance is listed and has no disabling constraint
  preventing the requested operation. Record relevant capability fields such
  as `canRunChildTask`; do not infer support for a particular installation
  adapter from that field.
- **Disabled:** the provider is listed but has an explicit constraint such as
  `Provider instance is disabled.` A model listing or delegation flag does not
  override that constraint.
- **Unavailable:** discovery itself is unavailable, or a provider cannot be
  established from runtime evidence. Do not relabel this as disabled.

Read current capability data each time; provider names, models, and constraints
are runtime evidence, not a permanent catalog. An installed model or profile
does not prove an active provider, and `canRunChildTask: false` alone does not
prove the provider instance is disabled.

Outside T3 Code, use established project configuration and evidence from the
active harness. If runtime discovery is unavailable, report that limit and
continue with supported update work; do not install, authenticate, or configure
a provider to fill the gap.

Keep three observations separate in the report:

1. **Installed adapter:** links/configuration present in the consumer.
2. **Runtime discovery:** a provider observed in the active harness.
3. **MCP connectivity:** a service connection actually checked by the relevant
   client. Neither installed files nor provider availability proves it.

## Reconcile request and destination support

An explicit scope such as “all enabled T3 providers” selects providers that
runtime discovery reports available. A request such as “Claude only” selects
Claude. A request naming no provider is a routine update: preserve current
adapters, including any adapters outside the requested scope. A narrower
request does not authorize removal; adapter removal needs separate
authorization.

Inspect the exact destination revision's setup documentation, installer flags,
distribution metadata, and adapter implementation before mapping selected
providers. Use only adapters demonstrably supported there. Report selected
providers with no supported adapter and continue the supported portions when
safe; do not invent compatibility from a shared skill format, model name, or
similar provider. OpenCode's existing setup documentation describes its own
supported use; it does not establish compatibility for other providers.

Apply existing setup rules consistently. Reuse Codex toolkit/profile choices,
Claude skill links, and enabled Basic Memory skill links where already
selected. Preserve the recorded memory choice, routing, overrides, and
conflict protections. A routine update never enables memory. For Claude, pass
the existing Claude adapter option only when Claude is selected or its
installation is already part of the consumer's established adapter set. The
installer adds `@AGENTS.md` to an existing consumer-owned root `CLAUDE.md`
when needed; it does not create that file. Existing Claude instructions and
symlinks are preserved, while ambiguous or conflicting instruction setups
must be reviewed before installation continues.

## Resolve and review the revision

“Latest main” is a valid target. Record the exact current pin and exact fetched
`main` commit before adopting it; a moving branch name is not a revision
record. Inspect destination migration notes, instructions, helpers, and
adapter support, then preserve the existing revision review and conflict
protections in the update procedure. Do not treat successful discovery as
approval to adopt the destination revision.

Example request:

> “Use update-agent-workflows to update this checkout to the latest main. In T3,
> configure adapters supported by that revision for all enabled providers.
> Preserve our existing adapters and recorded memory choice, report unsupported
> providers, and run our documented checks.”
