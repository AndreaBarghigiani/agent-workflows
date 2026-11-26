# Antigravity through T3 ACP

This document is setup guidance for agents running Antigravity/Gemini
through T3 Code's Agent Client Protocol (ACP) integration. It is not a
consumer instruction file. Follow the shared
[client connection reference](../.agents/skills/setup-basic-memory/references/client-connection.md)
for inspect, reuse, conflict, and reporting rules; this page records
Antigravity-specific observations. Workflow policy stays canonical in the
installed skills; Codex TOML profiles in `.codex/agents` remain
Codex-specific and do not apply to Antigravity.

Scope is supervised single-issue implementation and review through T3
`delegate_task`. Native Antigravity orchestration, nested milestone
delivery, standalone `agy` CLI use, and automatic sign-in are out of scope.
Facts below are labeled `runtime-verified`, `documented`, or `unverified`.

## How T3 runs Antigravity

- **Provider and runtime (runtime-verified):** `orchestrator_capabilities`
  advertises provider instance `antigravity` (driver `antigravity`),
  `canRunChildTask` and `canRunCrossProviderChildTask` true, no constraints.
  T3 starts "Antigravity ACP Server" `1.5.18` (`agy --version` `1.5.18`,
  via `mise`) with per-instance app-data directory
  `~/.t3/userdata/providers/antigravity/<instance-hash>/antigravity-acp`
  and config directory `.../config`.
- **Sign-in and auth routes (runtime-verified / unverified):** ACP
  `initialize` advertises `oauth-personal` ("Log in with Google"),
  `oauth-business` (Gemini Enterprise), `gemini-api-key` (Gemini Developer
  API), and `agent-platform` (Gemini Enterprise Agent Platform, formerly
  Vertex AI, with ADC) (runtime-verified). `t3-runtime-modes.json` records
  `authMethod: oauth-personal`, completed via T3's provider setup ACP login
  flow (`acp-login-*.log`) (runtime-verified). `gemini-api-key` and
  `agent-platform` are separately billed API/cloud routes and were not
  exercised (unverified). Standalone `agy models` reported "Please sign in",
  so T3's sign-in does not carry over to the standalone CLI
  (runtime-verified); the reverse is unverified.
- **Models and options (runtime-verified / unverified):** Selection happens
  in T3, not Antigravity config. `orchestrator_capabilities` advertises
  `gemini-4-neon` (Gemini 4 Neon) with `thought_level` in
  `low | medium | high | xhigh` (default `high`), plus
  `gemini-pro-orchestrator-neon` (Orchestrator (Neon)) and
  `gpt-oss-120b-medium` (GPT-OSS 120B (Medium)) with no advertised options
  (runtime-verified). Only `gemini-4-neon` was launched; `thought_level`
  `low` and `medium` were accepted (one child self-reported "Gemini 4 Neon
  (Low)") (runtime-verified), while internal effect is unverified.
- **Delivery profiles (documented):** Profile `reasoning` maps to T3's
  `thought_level` option at launch. Use the owner-directed
  [configure-delivery-profiles](../.agents/skills/configure-delivery-profiles/SKILL.md)
  skill to write `.agents/delivery-profiles.json` from live capabilities;
  see [delivery profiles](delivery-profiles.md). Never substitute targets
  silently:

```json
{
  "default": {
    "implement": {
      "provider": "antigravity",
      "model": "gemini-4-neon",
      "reasoning": "high"
    }
  }
}
```

- **Runtime modes (runtime-verified / unverified):** Advertised modes are
  `approval-required`, `auto-accept-edits`, `auto`, and `full-access`
  (runtime-verified). Child permission mode inherits from the parent by
  default — omit `runtimeMode` or pass `"inherit"`; see
  [deliver-issue](../.agents/skills/deliver-issue/SKILL.md) (documented).
  Only inherited `full-access` ran (other modes unverified).

## Workflow discovery (runtime-verified)

Verified in fresh `gemini-4-neon` children (`delegate_task`):

- **Shared checkout (`thought_level: low`):** Root `AGENTS.md` was present
  in startup context (`<user_rules>`) and quoted verbatim. The startup
  skills catalog listed all 16 project `.agents/skills` entries
  (`<root>/.agents/skills/<name>/SKILL.md`), six built-ins under
  `.../antigravity-acp/builtin/skills` (`agy-customizations`,
  `antigravity-guide`, `conversations`, `run-workflow`, `swarm_monitor`,
  `swarm_pane`), and three user skills from `.../config/skills`
  (`diagnose-crash`, `omarchy`, `omarchy-app`). Explicit reads of
  `implement-issue` frontmatter and reference-only `tailscale-web-dev`
  (`distribution: reference-only`), plus `gh auth status` and
  `gh issue view 4`, succeeded. No discovery adapter was needed. Because
  this repo is the library itself, `.agents/skills` holds real directories;
  symlinked consumer layouts and adopted/vendor-installed third-party
  skills are unverified.
- **Worktree (`isolation: "worktree"`, `thought_level: medium`):** T3
  created `~/.t3/worktrees/agent-workflows/t3-<id>` on a new branch at the
  parent commit with a clean tree and kept lifecycle ownership. Root
  `AGENTS.md` and all 16 project skills auto-discovered from the worktree
  path; `gh issue view 4` worked; `npm ci`, `node scripts/validate.ts`,
  `npx tsc --noEmit`, and `node --test` (551 pass, 0 fail on Node v24.22.3)
  all exited 0. `t3_readiness --project . --check` exited 1 twice with
  `Missing path: .../.agent-workflows-t3.json` because this library is not
  a readiness consumer (deterministic check runtime-verified; generated
  [T3 checkout readiness](t3-checkout-readiness.md) action on a real
  consumer worktree unverified).

## Configuration locations and precedence

- `~/.t3/userdata/providers/antigravity/<instance-hash>/antigravity-acp`:
  per-instance app-data, built-in skills, and logs (runtime-verified).
- `~/.t3/userdata/providers/antigravity/<instance-hash>/config`:
  `config/skills` symlinks to `~/.gemini/config/skills`;
  `config/mcp_config.json` was empty (0 bytes) on this host
  (runtime-verified).
- `t3-runtime-modes.json`: records `authMethod: oauth-personal`
  (runtime-verified).
- `.agents/mcp_config.json`: project MCP config honored by ACP for a local
  stdio fixture (runtime-verified; see Shared MCP).
- **Precedence (unverified):** No global or built-in skill shared a name
  with a project skill, so same-name shadowing precedence is unverified.
- **Startup warning (runtime-verified / effect unverified):** Every ACP
  start logged `"Not reloading plugin MCP servers: cannot get the signed-in
  user ... You are not logged into Antigravity"` despite working T3 OAuth
  model calls; effect is unknown (plugin MCP servers were not used).

## Shared MCP

- **Session server (runtime-verified):** Every child received T3's `t3-code`
  server (`mcp_t3-code_*`) as an eager ACP session MCP server (log:
  `"Preloading 1 MCP servers of the session"`). No other user MCP server was
  configured in T3 or `config/mcp_config.json`.
- **Project `.agents/mcp_config.json` (runtime-verified):** A disposable
  stdio fixture (`aw-fixture`, read-only `fixture_ping`, no credentials)
  logged `server/discover`, `initialize`, `notifications/initialized`, and
  `tools/list` at startup. The first probe reported it unavailable; a second
  fresh child after `sleep 15` invoked it as a lazy tool via `call_mcp_tool`
  (not an eager namespace) and received `pong-AW4-FIXTURE` (`tools/call`
  logged). Briefs should tell Antigravity children to look via
  `call_mcp_tool`. Whether the first miss was timing or a self-report error
  is unverified.
- **Toolkit gap (documented):**
  [configure-mcp](../.agents/skills/configure-mcp/SKILL.md)
  (`mcp_configure`) targets only `claude`, `codex`, and `opencode`, with no
  Antigravity (`.agents/mcp_config.json`) destination. Until added,
  registering [`.agents/mcp-requirements.json`](mcp-requirements.md)
  services for Antigravity is a manual owner-reviewed edit under check-only
  default and redacted-plan confirmation.

## Basic Memory

Client MCP configuration and project routing stay separate:

- No Basic Memory server was available to Antigravity children or the
  coordinator on this host, so routing, live schemas, reads, and writes are
  unverified and blocked on a configured server.
- Like Devin and Grok, `antigravity` is not a valid `clients` selection for
  [project-scope connection generation](memory/connections.md) (documented).
- A memory-declined consumer needs no Antigravity-side memory configuration
  by construction (no MCP access needed), unexercised with a fixture
  (unverified).

## Capability coverage

| Capability | Status | Observed result / notes |
| --- | --- | --- |
| T3 `delegate_task` (`gemini-4-neon`) | Runtime-verified | Launch & `thought_level` `low`/`medium` accepted; effect unverified. |
| Delivery profiles (`reasoning` map) | Documented | `reasoning` maps to `thought_level`; edit via `configure-delivery-profiles`. |
| Root `AGENTS.md` & project skills | Runtime-verified | Auto-discovered (16 real dirs); consumer symlinks & adopted skills unverified. |
| Reference-only skill pointers | Runtime-verified | Explicit read of `tailscale-web-dev` frontmatter succeeded. |
| Harness worktree (`isolation: "worktree"`) | Runtime-verified | T3 owns lifecycle; discovery & validation suite ran. |
| T3 checkout-readiness consumer action | Unverified | Library check exited 1 deterministically; consumer worktree untested. |
| GitHub CLI (`gh`) reads | Runtime-verified | `gh auth status` and `gh issue view 4` succeeded. |
| Local stdio `.agents/mcp_config.json` | Runtime-verified | Lazy via `call_mcp_tool`; first-probe miss cause unverified. |
| Remote/auth MCP & `configure-mcp` | Unverified / gap | Remote, auth, conflicts & isolation untested; no Antigravity target yet. |
| Basic Memory (routing, reads, writes) | Unverified | Blocked on configured server; not a valid `clients` selection. |
| Supervised implement & review delivery | Runtime-verified | Issue #4: Gemini implemented this guide (Codex-reviewed) and reviewed a separate README change. |

## Untested

- Consumer symlinked `.agents/skills`, adopted/vendor-installed third-party
  skills, and same-name skill shadowing precedence.
- Generated T3 checkout-readiness action on a real consumer worktree.
- Remote HTTP/SSE MCP, authenticated remote MCP with credential references,
  same-name conflicts, and instance isolation.
- Basic Memory routing, schemas, reads, writes, and a memory-declined
  fixture.
- `gemini-pro-orchestrator-neon`, `gpt-oss-120b-medium`, and internal
  effect of `thought_level` values.
- `oauth-business`, `gemini-api-key`, `agent-platform`, and standalone
  `agy` CLI sign-in carrying into T3.
- `approval-required`, `auto-accept-edits`, `auto`, plan interaction mode,
  and Antigravity as parent thread.
- Windows/macOS, T3 builds other than the T3 build used for issue #4
  validation, and Antigravity-specific refresh preservation (provider-agnostic
  installer was not re-run).

## Evidence

- 2026-11-26, Linux, the T3 build used for issue #4 validation, Antigravity
  ACP Server `1.5.18` (`agy --version` `1.5.18` via `mise`).
- `orchestrator_capabilities` recorded `antigravity` / `antigravity`,
  cross-provider child tasks, four runtime modes, and three models.
- Shared-checkout and worktree children verified discovery, explicit reads,
  `gh`, `npm ci`, `node scripts/validate.ts`, `npx tsc --noEmit`,
  `node --test` (551 pass, 0 fail on Node v24.22.3), and deterministic
  `t3_readiness --project . --check` exit 1 on the library checkout.
- Disposable `.agents/mcp_config.json` stdio fixture verified ACP discovery
  and lazy `call_mcp_tool` returning `pong-AW4-FIXTURE`.
- Issue #4 delivery: `gemini-4-neon` (`thought_level: high`) implemented
  this guide, and Codex `gpt-6.1-sol` reviewed it independently; its one
  finding (this claim was stated before the reviews finished) was fixed.
  `gemini-4-neon` (`thought_level: medium`) reviewed the separate README
  pointer change as reviewer and approved it with no findings.

## Gaps

- `configure-mcp` (`mcp_configure`) lacks an Antigravity
  (`.agents/mcp_config.json`) target; manual owner-reviewed edits under
  check-only default and redacted-plan confirmation apply meantime.
- Project MCP tools appear lazily via `call_mcp_tool`, not eagerly; briefs
  should note this, and the first-probe miss cause remains unverified.
- ACP startup logs a plugin-MCP "not logged into Antigravity" warning
  despite working T3 OAuth calls; plugin MCP impact is unknown.
- Basic Memory is unverified (no server on host) and `antigravity` is not a
  valid `clients` selection for connection generation.
- Consumer symlinked skills, adopted third-party skills, same-name
  precedence, and real consumer worktree readiness remain unverified.
- T3's OAuth sign-in does not carry over to standalone `agy`.
