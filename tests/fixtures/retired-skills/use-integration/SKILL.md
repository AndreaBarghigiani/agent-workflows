---
name: use-integration
description: Resolve a task's required service or external capability to the project's preferred integration instructions and use them within existing authorization. Use automatically when a task needs an external service or capability whose project guidance may apply.
---

# Use an integration

When a task needs an external service, tool, or capability, resolve it through the consumer project's integration index if one exists. Read only the matching reference and relevant linked authoritative instructions. If no index exists, inspect the consumer's `AGENTS.md` and the most relevant project documentation; do not enumerate tools or search the whole repository for every integration.

The [integration reference guide](../../../docs/integrations.md) shows a minimal index and the shared GitHub issue workflow guidance. Consumer-specific entries remain authoritative.

Consumer instructions, target choices, and overrides take precedence over shared examples. Pass the resolved reference, target context, and known limitations to delegated agents so they do not repeat discovery. Check access when needed for the task; prior evidence applies only while the target, identity, environment, and execution context still match.

Distinguish documented setup from observed access. Tool presence alone does not prove authentication or permission. A bounded read-only check can establish only the specific access it tested. If instructions are missing, stale, ambiguous, contradictory, or access fails, report the precise gap and its evidence. Make at most a focused follow-up lookup in the named authoritative source or ask for the missing consequential choice. Do not perform an exhaustive fallback search.

Use existing authentication and credential resolution. Never expose credential values in model context, repository references, memory, chat, or tool output. For protected 1Password resolution, follow the consumer's existing process; use [add-secret](../add-secret/SKILL.md) only for credential work already authorized within its 1Password/Varlock scope. Do not assume Varlock or a new key is required. Do not install tools, authenticate, change client connections, provision resources, or rotate credentials implicitly.

Basic Memory is optional. Do not query it automatically for routine integration use. Respect the consumer's recorded selection, routing, and write authorization. Its connection and routing instructions must remain locally readable without querying memory. If memory is disabled or unavailable, continue using repository instructions and report any meaningful unsaved decision only when relevant; do not prompt for setup.

Access guidance does not expand task authorization. Perform only actions already authorized by the user and project rules. Tool availability, authentication, and a successful read check do not authorize writes, messages, purchases, deployment, or cross-project changes.

## Output

Report the reference used, target and execution context, access evidence or precise limitation, actions taken within scope, and unresolved gaps. For delegation, include those same details in the handoff.
