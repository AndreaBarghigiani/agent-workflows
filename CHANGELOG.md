# Changelog

All notable changes to agent-workflows are documented here. This project uses
semantic versioning; see [Release versioning](docs/skill-distribution.md#release-versioning).

This is the public home of the library. It continues work earlier maintained in a
private repository, whose own changelog records those releases; version
numbering restarts here.

## [Unreleased]

## [0.2.0] - 2026-11-26

Run Antigravity Gemini delegates through T3 Code and align MCP services into Antigravity's workspace configuration.

### Added

- [Antigravity setup](docs/antigravity.md): an evidence-based guide to running Antigravity Gemini delegates through T3 Code's ACP integration. It covers provider, model and `thought_level` selection, Google sign-in routes, rule and skill discovery, harness worktrees, project `.agents/mcp_config.json` MCP servers, and the remaining gaps.
- `mcp_configure` (`configure-mcp`): added the opt-in `antigravity` client targeting `.agents/mcp_config.json` (`--clients antigravity`), aligning stdio (with inherited-environment credential prerequisites), no-auth remote (`serverUrl`), and OAuth remote services while reporting API-key/bearer remote services as `unsupported` because Antigravity does not expand environment references.

## [0.1.1] - 2026-11-25

Fit the generated T3 readiness action into T3 Code's script-ID limit.

### Fixed

- The generated T3 action id changes from `agent-workflows-checkout-readiness` to `agent-workflows-ready`: T3 limits script IDs to 24 characters and rejected the retired id when an entry carrying it reached a project update. `t3_readiness --configure-action` rewrites a retired-ID entry in place after the pin bump (plain, composed and Python-era entries), `update plan` lists the follow-up, and a generation-time check enforces the rule; import the action in T3 project settings after regeneration unless the project already registered it.

## [0.1.0] - 2026-11-24

Initial public snapshot of the agent-workflows library.

- The pinned workflow skills and the Node.js toolkit that installs, checks and updates them, behind a single TypeScript entry point (`bin/agent-workflows.ts`, Node.js 22.18 or newer). It includes the Basic Memory and MCP readiness and configuration helpers, optional T3 Code worktree setup and the read-only `update plan` command.
