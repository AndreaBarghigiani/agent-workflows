---
name: add-secret
description: Help a user save a provider credential in 1Password, then configure and validate its reference in an existing Varlock project. Use for adding or wiring secrets; not credential rotation or production provisioning.
---

# Add a secret

Guide the user through storing the value themselves, then do the authorized configuration work. Never ask for the secret value in chat. A saved-item confirmation is a prerequisite for resolution, not a new permission request when configuration is already authorized.

## Before the user saves it

Inspect project instructions, secret-management documentation, committed Varlock schemas, server imports, and environment types. Follow the existing task/issue workflow for repository changes. Identify the provider, variable name, environment, intended consumers, existing vault, and authentication/bootstrap mechanism. Resolve these from project context; ask only for missing consequential information.

Propose the item category, exact name, field label/type, and tags together. Match existing conventions. Under this standard convention, a typical proposal is:

- Vault: `Development`; category: `API Credential`.
- Item: `<project> / <provider> / development`.
- Field: the exact environment variable, using the Password type.
- Tags: `project:<project>`, `environment:development`, `managed-by:varlock`, `service:<provider>`, and one `consumer:<app>` per authorized consumer.

For shared provider keys, preserve an explicitly chosen `shared` item suffix and `environment:shared` tag; do not infer a different vault or authorize production provisioning from that tag. Use the field's exact secret reference, including its section path.

Explain where the user should paste the key inside 1Password. Do not create or rotate secrets through a read-only development service account. If the item is already saved, skip the creation instructions.

## After the user confirms it is saved

Continue automatically with configuration if authorized. Discover the item and field reference using existing authentication, or accept an `op://` reference supplied by the user. Prefer IDs when item names include slashes. Request a reference or item ID only if metadata discovery is unavailable or ambiguous. Do not request a fresh token when the project already has a working bootstrap.

Keep credential values out of tool output and model context. Use metadata-only operations where available. If the CLI returns values alongside metadata, capture its output inside a local process and emit only the selected item ID, title, field label/type, or reference. Never print full item JSON, resolved environment dumps, or an `op read` result. Do not cat local override/bootstrap files into context.

Determine the actual configuration location and precedence from the project. Use the existing resolver syntax, for example:

```dotenv
<PROVIDER>_API_KEY=op("op://Development/<ITEM_ID>/<PROVIDER>_API_KEY")
```

Write only a reference, never the secret value. Update the project's existing schema or local reference override as appropriate; don't invent a second secret-storage mechanism. Mark provider credentials sensitive, import them only into intended server consumers, and keep bootstrap tokens internal. Preserve optional behavior when the integration is designed to work without credentials.

For a local file that also contains private values, use a scoped local transformation that preserves unrelated contents without echoing them or writing copies into logs/repository files. Do not change desktop/system configuration merely because a secret override lives under `~/.config`. If an applicable project/tool instruction requires the user to edit that file, wire the non-sensitive reference in an allowed project schema instead, or explain the exact remaining manual step.

Check that repository changes contain only references/metadata and no secret values. Follow repository checks proportional to configuration changes. Avoid exporting the credential to unrelated server processes, browser builds, or test environments.

## Verify and hand off

Check the installed CLI's supported flags. Validate through Varlock's redacted agent output, scoped to the intended consumer. For example, when supported:

```bash
<pkg-manager> exec varlock load --path <app> --agent --filter <PROVIDER>_API_KEY
```

Confirm a value resolved, rather than treating an optional undefined variable or mere exit success as configured. Verify unintended consumers don't receive the variable. Never use unredacted output formats for diagnosis. Report exact missing-vault/item/field/access errors with credential values removed; don't fabricate success or broaden account permissions automatically.

Restart only the relevant local process when needed and authorized, preserving unrelated sessions. A live API test may consume credits or transmit data: perform it only within the user's existing authorization and use a bounded public/synthetic example. Configuring a reference does not itself authorize purchases, auto top-ups, deployment, remote secret provisioning, or sending private application data.

Report the item/reference location, configuration changed, actual validation result, and whether live provider verification occurred. Keep follow-up work visible if the user has not yet saved the item.
