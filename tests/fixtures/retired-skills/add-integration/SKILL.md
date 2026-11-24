---
name: add-integration
description: Register or update project-specific instructions for an external service, tool, or capability. Use when adding an integration reference or changing its preferred access, target, or credential guidance.
---

# Add an integration

Create or update a concise, project-owned integration reference using the existing authoritative documentation and configuration. First read the consumer's `AGENTS.md`, relevant engineering/security guidance, and any existing integration index or reference. Preserve existing records and local conventions.

Use the existing consumer documentation location when suitable. Otherwise use `docs/integrations/` with a short `index.md` mapping service names and capability descriptions to focused references. The index is a lookup aid, not a new configuration system. The consumer owns its entries; shared installers must not generate, rewrite, or replace them.

See the [integration reference guide](../../../docs/integrations.md) for a small index shape and portable reference example.

Each reference should record only what applies:

- Purpose and supported task boundaries.
- Preferred interface and how to select the project, account, environment, or resource.
- Credential mechanism by reference to the existing store/resolver; never include secret values.
- Representative safe invocation or links to authoritative project/vendor instructions.
- Restrictions, known limitations, and a bounded read-only access check.

Label configuration as documented and runtime access as observed. A configured tool does not prove it is authenticated or can access the intended target. Reuse known access methods; don't install tools, authenticate, provision resources, rotate credentials, or change client connections as part of documenting an integration.

For credentials stored in 1Password, describe protected resolution through the consumer's existing mechanism. Never resolve values into model context, references, memory, chat, or output. When the task includes already-authorized credential wiring in an existing 1Password/Varlock project, use [add-secret](../add-secret/SKILL.md); do not require Varlock or assume new credentials are needed.

Do not query Basic Memory automatically. Follow the consumer's local memory selection, routing, and write policy. Capture a meaningful reusable decision or lesson only when that policy allows it; never mirror routine integration records. Disabled or unavailable memory does not block this task or trigger setup.

Keep discovery bounded: inspect the relevant project instructions and existing references, then ask about only consequential gaps. Resolve stale, conflicting, or ambiguous target guidance before writing. Do not broaden into other projects. Documentation or tool availability never expands authorization for remote writes, messages, deployment, purchases, or other mutations.

## Output

Report the reference and index changed, authoritative sources reused, documented target and credential mechanism, access check performed or left unperformed, unresolved gaps, and any authorization needed for later runtime actions.
