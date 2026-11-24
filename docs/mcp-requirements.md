# MCP service requirements

An optional, consumer-owned `.agents/mcp-requirements.json` at the consumer
root declares which MCP services the project's workflows need. A client,
machine or fresh worktree can read it to identify the required services and
the prerequisites missing locally — without copying credentials and without
treating the tools one session happens to expose as project intent.

The library ships this document, the normative JSON Schema at
[`mcp-requirements.schema.json`](mcp-requirements.schema.json), the pure
Python loader, validator and readiness functions in
[`scripts/mcp_requirements.ts`](../scripts/mcp_requirements.ts), and the
example manifests under
[`tests/fixtures/mcp-requirements/`](../tests/fixtures/mcp-requirements/) —
never consumer requirements. `scripts/validate.ts` validates a root manifest
when one exists; an absent manifest changes nothing.

## Declaration, configuration, authentication, verified access, authorization

These are distinct states; the manifest covers only the first.

- **Declaration** — the manifest states project intent: which services
  matter, which workflows they apply to, and which project guidance governs
  them. Declaring a requirement creates or modifies nothing.
- **Configuration** — how a client reaches the service: client registration
  entries, launch commands, endpoints. Configuration stays native to the
  client and machine; the manifest references it but never contains or
  generates it.
- **Authentication** — presenting credentials. The manifest names the
  mechanism and the environment-variable names that hold credentials —
  never values, OAuth sessions or tokens.
- **Verified access** — bounded runtime evidence that a configured,
  authenticated client can actually use the service. The manifest records
  only the expected shape of that check (`verification`); the result is
  runtime evidence and is never written into the manifest.
- **Authorization** — what an agent may do. A declaration does not grant
  access and verified access does not expand authorization; mutations follow
  the user and project rules alone.

## Ownership

The file is consumer-authored and consumer-owned. Install and update runs
preserve it byte-for-byte — valid, customized or invalid; the helpers never
create, populate, repair or delete it, and never populate it from the tools
available in a session. The owner chooses whether to track it like any other
consumer file.

## Fields

- `version` — integer, currently `1`. Any other version is an actionable
  diagnostic, not a silent fallback.
- `services` — array of service requirements. Each entry:
  - `id` — stable service identity matching `^[a-z][a-z0-9-]*$`, unique
    within the manifest. It is distinct from any client registration name:
    an existing `basic_memory_nas` registration satisfies id `basic-memory`
    without being renamed.
  - `purpose` — non-empty description of what the service is for here.
  - `required` — boolean. An unavailable required service blocks only the
    workflows it applies to; an unavailable optional service never blocks.
  - `workflows` — non-empty array of workflow names the requirement applies
    to; `["*"]` means project-wide applicability.
  - `guidance` — non-empty array of repo-relative paths to existing project
    documentation covering usage and account or project constraints.
    References, not copies: every path must resolve in the repo, and
    unresolved references are diagnostics.
  - `connection` — optional portable connection description, an object with
    `type` `"remote"` or `"stdio"`.
    - `remote`: exactly one of `url` (a bare https endpoint — dot-separated
      ASCII hostname whose labels are letters, digits, hyphens and
      underscores, each starting and ending alphanumeric, with an optional
      numeric port — explicitly empty allowed — and an optional path; no
      userinfo, query string or fragment. Bracketed, internationalized or
      parameterized endpoints belong to machine-local details; the
      hostname grammar is enforced identically by the schema pattern and
      the Python validator) or
      `local_config_ref` (a free-form, machine-independent pointer to
      separately configured machine-local details — never an absolute or
      machine-specific path, and not validated as a repo path). Optional
      `auth`: `{"mechanism": "oauth"}` for an interactive flow, or
      `{"mechanism": "api-key", "credential_ref": "ENV_VAR_NAME"}` naming
      the credential's environment variable.
    - `stdio`: `command_ref` matching `^[A-Za-z][A-Za-z0-9_.-]*$` — the name
      of an environment variable or machine-local setting that holds the
      executable command, never the command, its path or a command line —
      plus optional `local_config_ref` for separately configured details.
  - `credential_refs` — optional array of environment-variable names
    matching `^[A-Z][A-Z0-9_]*$` the service needs beyond any auth
    `credential_ref`. Names only, never values.
  - `verification` — `{"description": "...", "read_only": true}`. The
    bounded read-only check that would verify access; `read_only` must be
    literally true.

`additionalProperties` is `false` at every level: no value-bearing field —
credential value, executable path, OAuth state, observed status — can hide
in a committed manifest, and reference fields are constrained to
machine-independent shapes (bare https endpoints, name-like references).
Structural validation cannot prove arbitrary secrets absent from free-form
prose such as `purpose`, `verification.description` or a descriptive
`local_config_ref`; that remains an authoring and review responsibility.

## Machine-local details and readiness

`scripts/mcp_requirements.ts` evaluates readiness as a pure function over
the manifest and a caller-supplied machine descriptor — synthetic data, not
probed state:

- `env`: environment-variable names present on the machine.
- `local_config_refs`: `local_config_ref` and `command_ref` pointers that
  resolve there. A mapping may carry the resolved details (endpoint,
  credential env-var name, launch setting) for reporting; those values stay
  machine-local.
- `registrations`: a mapping of service id to the client registration
  name(s) providing it. Existing native configuration remains usable and
  registration names need not equal the service id.

A service is provided when a registration covers its id or every declared
prerequisite resolves. A required-but-unavailable service blocks only the
workflows it applies to — all of them when it declares `["*"]`. An
unavailable optional service is reported as degraded and blocks nothing.
One unchanged manifest therefore works on machines whose local paths,
credential names and endpoints differ.

## Precedence and conflicts

Order of interpretation when sources disagree:

1. The declaration states project intent — it never rewrites itself from
   runtime observations.
2. Native client configuration may satisfy the declaration under any
   registration name; declaring a requirement does not transfer ownership
   of that configuration.
3. Machine-local profiles and settings supply the connection details the
   manifest points at.
4. Runtime evidence — the tools a session happens to expose — is evidence,
   never intent.

When these conflict — for example a registration for the service pointing
at a different endpoint than the declared `url`, or a required service
resolvable on one machine and not another — the conflict is reported with
its evidence. Nothing is silently chosen, renamed or migrated.

## Boundary: Basic Memory

A Basic Memory requirement references the existing contract rather than
copying it: guidance names
[`client-connection.md`](../.agents/skills/setup-basic-memory/references/client-connection.md)
and the `connection` uses `local_config_ref` to point at the machine-local
profile that already holds the endpoint and bearer-token env-var name (see
[project-scope client connections](memory/connections.md)). The profile is
not copied into the manifest and no universal connection store is created.
General services follow the same reference-only pattern through their own
consumer documentation, per the
[integration reference guide](integrations.md).

## Diagnostics

Validation reports every violation with its location and the fix:
unsupported `version`, duplicate `id`, invalid declarations (wrong types,
failed patterns, unexpected fields), unresolved `guidance` references, a
`read_only` that is not literally `true`, and reference fields carrying
absolute paths, command lines or parameterized URLs. Examples:
[`public-remote.json`](../tests/fixtures/mcp-requirements/public-remote.json),
[`authenticated-remote.json`](../tests/fixtures/mcp-requirements/authenticated-remote.json)
and
[`local-stdio.json`](../tests/fixtures/mcp-requirements/local-stdio.json)
cover a public remote MCP, authenticated remote MCPs and a local stdio
server.
