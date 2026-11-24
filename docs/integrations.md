# Integration references

External services, tools and capabilities are documented by each consumer project in its own instructions and engineering docs; the shared toolkit does not manage these records. Recording a preferred target or credential path is an ordinary documentation edit, and resolving the applicable guidance and the access actually available is ordinary agent work — no shared skill or index is required for either. A missing integration record does not block a clear, authorized task that already has an established access path, and routine tool use gains no mandatory authentication probes, browsing, or memory queries.

Project instructions establish the intended targets and restrictions, configuration and bounded runtime evidence establish available access, and current vendor or harness documentation establishes supported mechanics. When a task needs a service, read the consumer's `AGENTS.md`, relevant engineering docs and any existing integration records — an index such as `docs/integrations/index.md` is a valid consumer choice but is never required. Read only the matching reference; do not enumerate tools or search the whole repository for every integration. Consumer instructions and overrides take precedence over any shared example, and vendor or harness documentation stays authoritative for command and configuration mechanics; do not duplicate a command catalog into project docs.

## Recording an integration

Keep integration records concise and project-owned, in the consumer's existing documentation structure. Record only what applies:

- Purpose and supported task boundaries.
- Preferred interface and how to select the project, account, environment, or resource.
- Credential mechanism by reference to the existing store/resolver; never include secret values.
- Representative safe invocation, or links to authoritative project/vendor instructions.
- Restrictions, known limitations, and a bounded read-only access check.

Label configuration as documented and runtime access as observed. A configured tool does not prove it is authenticated or can reach the intended target, and a bounded safe read establishes only the specific access it tested. Reuse existing authentication and credential resolution; do not install tools, authenticate, provision resources, rotate credentials, or change client connections as part of using or documenting an integration. When instructions are missing, stale, ambiguous, or access fails, report the precise gap and its evidence rather than working around it. Access guidance never expands task authorization: remote writes, messages, deployment, purchases, and other mutations follow the user and project rules alone.

## Shared GitHub issue workflow reference

For this library's GitHub issue workflow, configure the `gh` CLI and use it as the preferred interface for GitHub issues and repository reads. `gh` uses its existing authenticated account and credential storage; never retrieve or copy its token. Confirm the selected account with `gh auth status`, select the explicit repository (`OWNER/REPO`) when the checkout's remote is not sufficient, and state the relevant account or organization in the handoff. A signed-out browser does not establish that GitHub access is unavailable.

Check documented configuration separately from observed runtime access. When access is needed, use a safe targeted read such as:

```bash
gh auth status
gh issue view 25 --repo OWNER/REPO
```

The first command reports account status; do not copy tokens or credential-bearing output into notes or handoffs. The second verifies only read access to that issue and repository at that time. Do not run a write check. Any later issue or repository mutation must be separately authorized by the user and the relevant workflow; tool access and setup do not grant it. Authentication or permission failure is a precise access gap; do not switch to browser login, install tooling, or change credentials implicitly. This prerequisite applies to the GitHub issue workflow, not every integration or all consumers.

Consumers may keep this as `docs/integrations/github.md` and point to it from an index or their instructions. Follow consumer overrides when they use an approved alternate workflow. Coordinators should pass that resolved reference, repository/account context, and known access limits to implementers and reviewers. Recheck at runtime only when the operation needs it or earlier evidence no longer applies.

## Synthetic project-specific example

This example illustrates a consumer override and a protected credential path; it is not a real integration configuration. Imagine a project that documents an internal error-monitoring service in `docs/observability.md` and uses a service-specific command already installed in its development environment:

```markdown
# Error monitor

- Purpose: inspect an event in the staging project.
- Preferred access: existing `observe` command, documented in
  `docs/observability.md`; this project does not use the
  shared example's generic API client.
- Target: `acme-staging`, selected with `--project acme-staging`.
- Credential: the command resolves `OBSERVE_TOKEN` through the project's
  existing protected 1Password resolver. Never print or export its value.
- Bounded check: `observe event get evt_synthetic_123 --project acme-staging`.
- Restriction: read-only inspection; no event mutation or alert changes.
```

If the project guide overrides a shared tool or target, the consumer instruction wins. If access uses an existing authenticated desktop session or MCP tool instead, document that interface and its target selection; do not infer that a new API key or Varlock is needed. Record the command and target as configured, and describe the result as observed only after actually running it. Synthetic identifiers should be used for examples and controlled checks.

When a check fails, distinguish a missing reference, stale command, ambiguous target, unavailable tool, and denied access. Report the exact evidence without including credential values. Memory may retain a reusable decision only under the project's existing policy; it must not mirror this routine record.

## Retired integration skills

This revision removes `add-integration` and `use-integration` from the shared toolkit. Their responsibilities were not distinct: recording a project decision is an ordinary documentation edit, and resolving project guidance and available access is ordinary agent work. Existing consumers pick the change up through the normal reviewed refresh; no automatic consumer documentation rewrite or external rollout is introduced.

- Fresh installations derive the toolkit from the pinned revision and never include either skill.
- On refresh, the installer retires only state it can prove is toolkit-owned: a broken link in `.agents/skills` or a contained hidden harness `.*/skills` folder resolving to the retired skill path inside the pinned library, and a real directory whose complete file set matches the retired content byte for byte and has neither consumer adoption provenance nor incoming harness links. Each removal prints a `retired:` line; `--check` reports the same entries with the repair command.
- Same-name entries that are not proven toolkit-owned — a customized copy, a directory differing in any file, a directory without a regular `SKILL.md`, a link outside the retired path, or an unrelated same-name skill installed by another tool — are preserved and reported with a `preserved:` diagnostic naming the entry and why it did not qualify. Remove them only after a reviewed decision; a matching name alone never proves toolkit ownership.
- Consumer-authored integration references, indexes, `AGENTS.md` pointers, client configuration and credentials are consumer-owned and untouched. An existing pointer such as a routing line to `docs/integrations/index.md` stays valid as ordinary project documentation; nothing maintains or requires it, so keep or remove it by owner decision.
- Legacy `.agent-workflows-t3.json` `skills` arrays naming the retired skills are already ignored by the readiness helpers, and adoption provenance in `.agents/adopted-skills.json` is preserved with the entries it describes. Exact copies recorded there, or referenced by incoming links in the discovered harness folders, are preserved for a reviewed decision covering the copy, links and provenance together. An unreadable or unrecognized manifest also preserves copies until provenance can be reviewed. Folder discovery stays within project-contained hidden `.*/skills` folders; external folders and library/Git storage are excluded from removal, including when default skill folders are redirected there. Hidden top-level symlinks are not discovered as additional harnesses. Incoming-link detection covers direct entries in these skill folders; links from other locations or inside another skill are not detected, so review those references before refreshing.
- Refresh is idempotent and applies identically to memory-enabled and memory-declined consumers.
- Returning to a pin that still ships the skills restores them through the normal derived toolkit: the older installer recreates the managed links, and a preserved same-name entry at a managed path is reported by that older installer as a local skill conflict, exactly as before the retirement.
