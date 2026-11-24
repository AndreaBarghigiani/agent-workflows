# Delivery profiles

An optional consumer-owned `.agents/delivery-profiles.json` at the consumer
root selects the provider, model and reasoning effort used when delegating
delivery roles: the implement and review roles `deliver-issue` delegates, and
the optional orchestrator role `deliver-milestone` uses for its per-issue
coordinators. The library ships only this
document, the JSON Schema at
[`.agents/delivery-profiles.schema.json`](../.agents/delivery-profiles.schema.json)
in the pinned library, and the example below — never project model values. The
file is created only on explicit opt-in during setup and is preserved
byte-for-byte by install and update runs.

## Schema

Every top-level property name is a profile key; no `default` key is required
and `{}` is valid. Each profile is an object with optional `implement`,
`review` and `orchestrator` roles. Each role requires non-empty `provider` and
`model` strings and accepts an optional `reasoning` string: a neutral value the
coordinator maps to the provider's own option at runtime, never a guessed
provider-specific value.

```json
{
  "default": {
    "implement": { "provider": "provider-name", "model": "model-id", "reasoning": "reasoning-level" },
    "review": { "provider": "provider-name", "model": "model-id", "reasoning": "reasoning-level" },
    "orchestrator": { "provider": "provider-name", "model": "model-id", "reasoning": "reasoning-level" }
  },
  "cheap": {
    "implement": { "provider": "provider-name", "model": "model-id", "reasoning": "reasoning-level" },
    "review": { "provider": "provider-name", "model": "model-id", "reasoning": "reasoning-level" }
  }
}
```

The `orchestrator` role is optional everywhere: it configures only the
per-issue coordinators `deliver-milestone` launches. Direct `deliver-issue`
calls stay coordinated by the calling session and never consume this role.

## Resolution

- A model named in the request overrides the profile for that role.
- A keyword in the request selects the matching named profile.
- With neither, the coordinator asks whether to use `default` or one of the
  listed alternatives; when the session cannot ask, it uses `default` and
  discloses the choice.
- A missing file or `{}` applies the shipped `issue-implementer` and
  `issue-reviewer` Codex profile defaults directly, with no profile-selection
  prompt.
- `orchestrator` resolves only for `deliver-milestone`'s per-issue
  coordinators: from the selected named profile's `orchestrator` role, then
  `default.orchestrator`. When neither defines it, the milestone caller's own
  provider, model and settings apply only when they are discoverable and
  launchable for a child task in the connected harness; otherwise the
  coordinator requests an explicit choice before launching anything. The
  resolved selection is disclosed either way.

Malformed JSON or a populated file that fails the schema is a clear error
reported before delegation, never a silent fallback.

## Role fallback

A role missing from the selected profile falls back to the `default` profile's
role. When `default` is absent or also lacks the role, `implement` and `review`
use the shipped `.codex/agents` agent defaults, while `orchestrator` falls back
to the milestone caller described above — the library ships no orchestrator
profile default.

## Delivery roles

- The milestone caller is the session running `deliver-milestone`: it owns
  milestone assessment, scheduling, authorization, escalation, integration
  across issues, and the final report.
- Each per-issue orchestrator is a fresh child the milestone caller launches
  with this role; it follows `deliver-issue` for one issue, including its own
  implement and review delegation.
- The implementer carries out a bounded slice and the independent reviewer
  verifies it; `deliver-issue` coordinates both inside each issue's delivery.

## Persisting an owner-named model

When the owner names a model for a role at the plan checkpoint and the
consumer has no `.agents/delivery-profiles.json` (or only `{}`), the
coordinator offers to persist that role's resolved provider, model and
reasoning into the `default` profile as owner-directed configuration,
pointing to the guided interactive flow below. Persisting happens only on
explicit owner consent; declining changes nothing and the named model still
overrides for the session without a file.

## Model availability

Before launching, the coordinator checks the chosen models against the client's
live capabilities. For `orchestrator` that check includes whether the harness
can actually launch a child coordinator on the resolved provider and model.
When a chosen model is unavailable or cannot launch the required child task it
says so and asks; it never substitutes another model silently.

## Choosing values interactively

The read-only
[inventory-delivery-capabilities](../.agents/skills/inventory-delivery-capabilities/SKILL.md)
skill lists the providers, launchable models and supported options visible to
the current harness session. It is useful on its own when the owner wants a
catalog to consult while editing JSON manually. Its results are a session
snapshot, not subscription or billing guarantees.

Creating or changing profile values is a guided, owner-directed flow: the
installed [configure-delivery-profiles](../.agents/skills/configure-delivery-profiles/SKILL.md)
skill first presents that same live inventory, then walks the owner through a
per-role pick with explicit consent — including the optional `orchestrator`
role for consumers that use `deliver-milestone` — writes the chosen values and
verifies the file against the schema. It presents the inventory even when the
file is empty or missing. Run it again when provider subscriptions or connected
harnesses change, or when you want to refresh choices against newly available
models.

Discovery comes from the connected harness at creation time, never from this
document or memory. In T3 Code, `orchestrator_capabilities` returns
`providerInstanceId`, launchable model IDs and option variants; store that
vocabulary directly — `provider` is the `providerInstanceId`, `model` the
launchable model ID, `reasoning` the matching option value — so profiles are
consumable by delegate-style launches with zero translation. OpenCode-native
sessions expose a structured `models` listing, and CLI harnesses have their own
list commands (for example `devin models`). When no discovery surface is
reachable, exact IDs come from the owner and the lack of live verification is
disclosed rather than hidden.

## Setup and updates

Setup offers to create the file containing only `{}` when it is missing
(`install.ts --delivery-profiles`); declining leaves the shipped defaults and
is not recorded. An existing file — valid, customized or invalid — is
preserved byte-for-byte on every install and update run; the helpers never
populate, replace or repair it.
