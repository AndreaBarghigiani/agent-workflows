---
name: configure-delivery-profiles
description: Guide the owner through creating or changing a consumer's `.agents/delivery-profiles.json` from live harness capabilities. Use when setting per-role provider, model and reasoning values for delivery; not for routine install or update runs, which preserve the file byte-for-byte.
---

# Configure delivery profiles

Goal: a consumer-owned `.agents/delivery-profiles.json` that maps the
implement, review and optional orchestrator roles to provider, model and
reasoning values the connected harness can actually launch, chosen and verified
interactively with the owner. This is
owner-directed configuration, not installation: the install and update helpers
never populate, replace or repair the file and preserve it byte-for-byte. This
skill is how values get in on purpose.

## When to use it

Use it when creating delivery profiles for the first time — including right
after `install.ts --delivery-profiles` created the empty `{}` file — and when
the owner wants to refresh or change values in an existing file. This is useful
after enabling or disabling a provider subscription, connecting a new harness,
or when new models become available. Recheck live capabilities whenever the
owner asks; do not wait for a scheduled update. Existing values change only
with explicit owner approval; show what would change before writing. A missing
or empty file needs no configuration: it applies the shipped `.codex/agents`
defaults.

## Discover live capabilities first

Provider and model vocabulary comes from the harnesses connected to the session
at creation time, never from documentation, memory, or this library's own
examples. First follow the read-only
[inventory-delivery-capabilities](../inventory-delivery-capabilities/SKILL.md)
skill and show its live inventory, even when the profile file is missing or
empty. Reuse that discovery snapshot for the rest of this configuration flow;
do not query the same harness a second time in the thread. If no discovery
surface is reachable, ask the owner for exact IDs and disclose that no live
verification happened; report providers that cannot be resolved as unverifiable
rather than silently writing them.

In T3, store the capability listing's own vocabulary: `provider` is the
`providerInstanceId`, `model` is the launchable model ID, and `reasoning` is
the matching option value, such as an effort option. Profiles written this way
are consumable at delivery time with zero translation. Never hard-code catalog
contents or guess an identifier; prefer provider names the coordinating client
can actually resolve when it launches the role.

## Choose values with the owner

After presenting the inventory, walk the owner through a per-role pick for
`implement` and `review`, including optional named profiles if they want them.
Offer `orchestrator` as an optional third role — it configures only the
per-issue coordinators `deliver-milestone` launches, so pin it only when the
owner uses or plans milestone delivery and the harness reports child-task or
delegated launches for the choice. An unpinned `orchestrator` falls back to
`default.orchestrator`, then to the milestone caller's own provider and model
when discoverable and launchable.
Do this even when the file is empty: empty means the shipped defaults currently
apply, not that there are no available models to compare. Each proposed change
needs explicit consent; show the complete proposed JSON before writing. A role
left unpinned falls back through the `default` profile — `implement` and
`review` to the shipped agent defaults, `orchestrator` to the milestone caller
— so pin only what the owner chooses deliberately. Keep the file small.

## Write and verify

Write JSON matching the
[schema](../../../.agents/delivery-profiles.schema.json): every top-level key
is a profile name, each profile holds `implement`, `review` and/or
`orchestrator` roles, each role requires non-empty `provider` and `model`
strings and accepts an optional `reasoning` string, with no extra keys.
Validate the written file structurally
before finishing with a stdlib-only inline check run from the consumer root —
it parses the JSON, verifies role and key names, verifies non-empty strings and
rejects unknown keys:

```bash
node -e '
const fs = require("fs");
const roles = new Set(["implement", "review", "orchestrator"]);
const keys = new Set(["provider", "model", "reasoning"]);
let data;
try {
  data = JSON.parse(fs.readFileSync(".agents/delivery-profiles.json", "utf8"));
} catch (error) {
  console.log(error.message);
  process.exit(1);
}
const top = data && typeof data === "object" && !Array.isArray(data);
const errors = top ? [] : ["top level must be an object"];
for (const [name, profile] of Object.entries(top ? data : {})) {
  const bad =
    !profile || typeof profile !== "object" || Array.isArray(profile) ||
    Object.keys(profile).some((r) => !roles.has(r));
  if (bad) {
    errors.push(`${name}: profiles hold only implement/review/orchestrator roles`);
    continue;
  }
  for (const [role, spec] of Object.entries(profile)) {
    if (!spec || typeof spec !== "object" || Object.keys(spec).some((k) => !keys.has(k))) {
      errors.push(`${name}.${role}: bad object or unknown keys`);
      continue;
    }
    if (!["provider", "model"].every((k) => typeof spec[k] === "string" && spec[k])) {
      errors.push(`${name}.${role}: provider/model need non-empty strings`);
    }
    if ("reasoning" in spec && typeof spec.reasoning !== "string") {
      errors.push(`${name}.${role}: reasoning must be a string`);
    }
  }
}
console.log(errors.join("\n") || "delivery-profiles.json is schema-shaped");
process.exit(errors.length ? 1 : 0);
'
```

Report every error before finishing; fix the file or restore the prior
consumer-owned content rather than leaving a broken one, because malformed JSON
at delivery time is a clear error, never a silent fallback. Then run the
consumer's pinned install helper check from the consumer root as a health check
— `node .agent-workflows/bin/agent-workflows.ts install --project . --check`, adjusting
for the consumer's library path. Adding `--delivery-profiles` confirms the
file's presence is expected; the helper reports an existing file as preserved
and writes nothing.

## Close out

Tell the owner what the file controls — per-role provider, model and reasoning
for `deliver-issue` delegation and the optional `orchestrator` for
`deliver-milestone`'s per-issue coordinators — that a missing or empty file
applies the
shipped agent defaults, and that install and update runs preserve it
byte-for-byte. Link [delivery profiles](../../../docs/delivery-profiles.md) for
the documented example, schema and resolution rules. When a chosen model turns
out unavailable at launch, the coordinator blocks with a question rather than
substituting silently. The same disclosure rule governs this flow: with
explicit owner consent, owner-supplied exact IDs may be saved while recorded
as unverifiable — never written silently, and the file never hides which
values lack live verification.
