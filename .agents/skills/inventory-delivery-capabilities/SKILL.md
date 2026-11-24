---
name: inventory-delivery-capabilities
description: List the providers, launchable models, and supported options visible to the current harness session. Use when comparing available delivery models or preparing to edit delivery profiles; read-only and does not change subscriptions or files.
---

# Inventory delivery capabilities

Produce a current, read-only inventory of provider and model choices visible to
the harnesses connected to this session. This is a snapshot for the owner to use
when editing `.agents/delivery-profiles.json` — for the `implement`, `review`
and optional `orchestrator` roles; it does not edit that file or any
other file, and it cannot activate subscriptions or connect providers.

## Discover once

Query each capability surface available in the current client. Use the surface's
own provider IDs, launchable model IDs, and option vocabulary; never infer IDs
from examples or translate them silently.

- T3 Code: call `orchestrator_capabilities` once per thread and use its
  `providerInstanceId`, launchable model IDs, child-task availability, and
  supported option values. Prefer an unfiltered result for the inventory; if
  the result is too large, use the tool's search filter and label the report as
  partial.
- OpenCode-native sessions: use the structured model listing available to the
  session.
- CLI harnesses: use their model-listing commands, such as `devin models`, when
  shell access and that client are available.

Report which discovery surfaces you checked. A model list only describes what
the current client exposes; it does not establish account billing, subscription
entitlements outside that client, or future availability. Mark a provider or
model as unavailable or unverifiable when the source cannot confirm it. Do not
substitute a nearby model.

## Present the inventory

Group results by provider and show a Markdown table with:

- the exact provider ID to use as `provider`;
- each exact launchable model ID to use as `model`;
- child-task or equivalent launch availability when the source reports it;
- supported option names and values, including effort levels when present.

Child-task availability matters for the optional `orchestrator` role:
`deliver-milestone` launches per-issue coordinators with it, so mark choices
the harness cannot delegate to as unusable for that role.

Include any query limitation and make clear the inventory was observed in this
session. When useful, provide copy-ready JSON fragments for individual choices.
Keep JSON valid: no comments, guessed values, or catalog dumps inside the
consumer's profile file. The owner decides what to retain in that file.

Do not ask the owner to choose roles as part of this read-only inventory task.
Do not modify profile files, subscriptions, credentials, or provider settings.
The owner may invoke this skill again after changing subscriptions, connecting
a harness, or when new models become available.
