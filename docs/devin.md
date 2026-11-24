# Devin through T3 ACP

This document is setup guidance for agents performing Devin setup through
T3 Code's Agent Client Protocol (ACP) integration. It is not a consumer
instruction file. Follow the shared
[client connection reference](../.agents/skills/setup-basic-memory/references/client-connection.md)
for the inspect, reuse, conflict, and reporting rules; this page supplies the
Devin-specific observations. Workflow policy stays canonical in the installed
skills. Codex agent TOML profiles in `.codex/agents` remain explicitly
Codex-specific and do not apply to Devin.

## How T3 runs Devin

- T3 Code launches the Devin CLI in ACP mode (`devin acp`) as a registered
  provider (`acpRegistry_devin`). This matches the official registry shape,
  where an ACP registry entry declares `"cmd": "devin", "args": ["acp"]`.
- Model and option selection happens in T3, not in Devin configuration.
  `orchestrator_capabilities` advertises the provider instance with its
  launchable models and per-model options (`mode`, `thought_level`, `speed`
  on the SWE models). Delivery profiles store exactly this vocabulary; see
  [delivery profiles](delivery-profiles.md). Never assume Codex profiles
  apply to Devin and never substitute a target silently.
- Child permission mode is inherited from the parent thread by default:
  omit `runtimeMode`, or pass `"inherit"` explicitly; see
  [deliver-issue](../.agents/skills/deliver-issue/SKILL.md).

## Workflow discovery (runtime-verified)

Verified in a fresh Devin ACP session against a disposable consumer fixture
(root `AGENTS.md`, one installed skill, one reference-only pointer):

- Root instructions: the session reported the fixture's marker phrase
  verbatim, so root `AGENTS.md` is loaded.
- Installed skills: `.agents/skills` links are discovered and readable; the
  session read the installed skill's frontmatter `name`.
- Reference-only pointers: the session resolved a root-instructions pointer
  to a library reference-only skill and read its
  `distribution: reference-only` frontmatter.
- No discovery adapter was needed: the existing installation suffices.

During the same day's deliveries, fresh Devin ACP sessions read the library
root `AGENTS.md` and the `implement-issue` skill, edited files, and ran
validation commands with no approval prompts.

## Configuration locations and precedence

From the official Devin documentation (docs.devin.ai) — recorded as
documentation, not runtime-verified in this checkout:

- Local per-user ACP registry: `~/.windsurf/acp/registry.json`
  (Devin Desktop), `~/.windsurf-next/acp/registry.json` (Devin Desktop
  Next), `%USERPROFILE%\AppData\Roaming\Code\User\acp\registry.json`
  (Windows).
- Team administrators can push an ACP registry through the
  "ACP Registry Config" setting in Devin Settings.
- CLI: `--config <path>` selects a configuration file; `--model` (or the
  `DEVIN_MODEL` environment variable) sets the default model for new ACP
  sessions; `--respect-workspace-trust` defaults to `true`.
- `devin rules` manages always-on context ("rules"); `devin rules paths`
  lists the rule directories.
- `devin mcp add/remove/login` manages CLI-side MCP configuration with
  scopes; `/mcp` is the in-session command.

The override order between a team-pushed registry and the local registry
file was not probed at runtime here and stays explicitly unverified.

## Basic Memory

Client MCP configuration and project routing are separate concerns:

- T3 exposes its configured MCP servers to Devin ACP sessions. A fresh
  session listed the configured Basic Memory server and its tools
  without any Devin-side configuration; the connection comes from the
  harness, not from Devin config.
- A scoped native read was verified from a fresh Devin session:
  `list_memory_projects` returned the server's project list, and
  `read_note` returned a note by exact permalink. Neither call needed an
  explicit `project` argument — scoping resolved from the harness-configured
  server, because the fixture consumer declares no routing of its own.
- Consumer project routing (`.agents/memory/config.md` and the manifest's
  `memory.routing_source`) is a library artifact and stays independent of
  the Devin client connection. Memory setup follows the shared connection
  reference; no Devin-specific memory steps were required. The
  [project-scope connection generation](memory/connections.md) takes no
  Devin file either: a Devin session inherits whatever MCP servers T3
  exposes, so `devin` is not a valid `clients` selection.
- A memory-declined consumer needs no Devin-side memory configuration and
  no probes: the fixture consumer used for discovery declared no routing,
  and the Devin session required nothing beyond what T3 already exposes.
- Memory writes from Devin sessions were not tested; they are not authorized
  by verification work.

## Untested

- Standalone Devin CLI outside T3 (interactive sessions, `/login`,
  `--export`/ATIF output).
- Windows and macOS; this verification is Linux-only.
- Team-registry versus local-registry precedence, and `--config` override
  behavior at runtime.
- Devin CLI versions other than the one recorded below; official docs note
  that ACP capabilities are advertised by the installed runtime and can
  differ by version and account.

## Evidence

- Linux validation used Devin CLI 3000.11.234 and T3 0.1.7.
- Fresh ACP sessions exercised implementation, inherited permissions, skill
  discovery, and a scoped memory read. Availability depends on the runtime
  and account.

## Gaps

- Registry precedence details (team versus local) are documented as separate
  mechanisms but the effective override order was not reproduced here.
- Memory tool *listing* and one scoped read are verified; the remaining
  memory surface (search across projects, schema tools, writes) is untested
  from Devin sessions.
