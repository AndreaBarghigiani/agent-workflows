# Claude Code setup

This document is setup guidance for agents performing Claude Code setup. It is
not a consumer instruction file and must not be copied into a consumer's
`CLAUDE.md`.

This library's skills are plain `SKILL.md` files in `.agents/skills`. Claude Code
does not read that directory, so a consumer needs the Claude adapter below for
skill discovery. Instructions are read from `AGENTS.md`, subject to the rules in
the next section.

## Evidence and limits

- Linux, Claude Code 2.1.312 (`claude --version`). Probe: a temporary consumer
  built from library commit e0a09a2 with this change's `scripts/install.ts`,
  installed with `--claude-skills`. A fresh non-interactive `claude -p` session
  listed all 11 toolkit skills in its init event and reported the consumer
  `AGENTS.md` heading. The init event reported `claude-opus-5-5`; the probe did
  not pass a model flag. A control run with `.claude/` moved aside listed none of
  the toolkit skills, although `.agents/skills` was present.
- Not verified: Mac; interactive `/` menu and `/context` checks; Basic Memory
  reads from Claude; Claude delegation or subagents; Codex discovery in this
  slice.

## How Claude Code loads instructions and skills

These default behaviors come from the official Claude Code docs
([memory](https://code.claude.com/docs/en/memory),
[skills](https://code.claude.com/docs/en/skills),
[subagents](https://code.claude.com/docs/en/sub-agents)) and may change.

- **Instructions.** By default, Claude reads `AGENTS.md` directly only when no `CLAUDE.md`,
  `CLAUDE.local.md`, or `.claude/CLAUDE.md` exists in the working directory or
  above it. If one exists, Claude reads only those files unless they import
  `AGENTS.md`. Direct reading needs v2.1.277+; before v2.1.281, some sessions
  (for example Bedrock or telemetry disabled) read `CLAUDE.md` only.
- **Import.** A `CLAUDE.md` containing the line `@AGENTS.md` loads the shared
  file on versions supporting imports, subject to effective instruction
  settings. When the Claude adapter is selected, `install.ts --claude-skills`
  adds this import to an existing root `CLAUDE.md` if needed, preserving its
  content. It never creates `CLAUDE.md` solely for the import. Symlinks needing
  changes and ambiguous setups require review.
- **Skills.** Project skills load from `.claude/skills/<name>/SKILL.md`, and a
  symlinked entry is read from its target. Changes are picked up during a
  session. `.agents/skills` is not read.
- **Subagents.** Claude reads Markdown files in `.claude/agents`, not the Codex
  TOML profiles in `.codex/agents`. This adapter creates no Claude subagents.
- **Configuration overrides.** Instruction modes `claude-md-and-agents-md`,
  `claude-md`, and `managed-only` alter loading. Check the effective mode and
  whether the built-in plugin is disabled when troubleshooting missing instructions.

## Set up a new consumer

From the consumer root, after adding the submodule (see the README):

```bash
node .agent-workflows/bin/agent-workflows.ts install --project . \
  --memory <enabled|declined> --codex-agents --claude-skills
node .agent-workflows/bin/agent-workflows.ts install --project . \
  --memory <enabled|declined> --codex-agents --claude-skills --check
```

Omit `--codex-agents` when Codex profiles are not used. `--claude-skills` links
the same installed toolkit as `.agents/skills` into `.claude/skills` using
relative symlinks. Consumer-owned directories or files in `.claude/skills` are
never replaced; a same-named local directory is refused before any link is
written. Rerunning is idempotent. The installer never removes a link.

## Upgrade an existing consumer without Claude support

Use the consumer's approved pin first. Advancing the library pin is a separate
reviewed step (`update-agent-workflows`); this procedure does not change it.

1. Record the current state: `git status --short`, and the `memory` value in
   `.agent-workflows-capabilities.json`. Leave uncommitted work untouched.
2. Check for conflicts: `ls -la .claude/skills 2>/dev/null`. A toolkit-named
   directory that is not a symlink into `.agent-workflows` blocks the install.
   Move it aside only after review; do not delete it.
3. Run the same installer command as before with `--claude-skills` added. If
   the capabilities file exists, omit `--memory` to reuse the recorded choice;
   a different value is refused. Then run the same command with `--check`.
4. For an existing memory-enabled consumer with reviewed routing, also run:
   `node .agent-workflows/bin/agent-workflows.ts setup_memory --project . --claude-skills`
   and repeat with `--check`. Preserve an existing `--share-config` choice.
   New memory setup still requires the reviewed portable routing input described
   in `setup-basic-memory`. These commands create local links only; configure
   Claude's MCP connection separately under the consumer's existing authorization.
5. Review the result. Expected changes are new symlinks under `.claude/skills/`
   and no edit to existing files. Existing `AGENTS.md` policy blocks should be
   unchanged.
6. Review the instruction setup. If an existing root `CLAUDE.md` is present,
   the selected Claude installer adds `@AGENTS.md` when needed. If it is absent,
   the installer leaves it absent; Claude Code 2.1.281+ can load root
   `AGENTS.md` directly when no higher-priority Claude instruction file changes
   discovery. Resolve symlink or conflicting setups explicitly.
7. Start a fresh session in the consumer root (`claude`). Confirm the `/` menu
   lists toolkit names such as `shape-issue`, and `/context` lists the loaded
   instruction files under Memory files. Record the Claude version.
8. Commit or stage the links only under the consumer's branch rules and the
   owner's authorization.

**Rollback** is manual and reviewed. List library links with
`find .claude/skills -maxdepth 1 -type l -lname '*agent-workflows*'`, then remove
only the ones you decide to drop. The installer reports stale library links and
refuses to continue; it never removes them. The exceptions are removals it can
prove: a broken link to a Basic Memory skill the library used to vendor, and a
broken link or byte-exact copy of a retired toolkit skill (currently
`add-integration` and `use-integration`), which it removes and reports as
`retired:`. Same-name content it cannot prove is preserved and reported.

## Gaps

- The `setup-basic-memory` link requires `setup_memory.ts --claude-skills`, and
  Basic Memory's own skills come from the
  [upstream installer](memory/upstream-skills.md); local
  installation does not establish a working Claude MCP connection.
- T3 worktree checkouts (`scripts/t3_readiness.ts`) do not create
  `.claude/skills` links.
- No Claude subagent equivalents of the Codex `issue-implementer` and
  `issue-reviewer` profiles exist yet.
- Discovery shows that a skill is listed, not that a task invoked it correctly.

The import preflight uses a bounded Markdown scanner. Container-nested or
indented code (including spaces or tabs) and ambiguous code spans require a reviewed instruction edit;
the installer reports these setups before writing any consumer files. It does
not attempt to rewrite complex Markdown.

Alternate `.claude/CLAUDE.md` and `CLAUDE.local.md` instruction files also
require explicit review before refresh; they can change which root instructions
Claude loads. They are preserved, and the helper does not silently create a
root instruction file to bypass them. Escaped backtick runs that are ambiguous
to the bounded scanner are likewise reported before writes.


## Basic Memory connection and verification

For a memory-enabled consumer, retain `.agent-workflows-capabilities.json`
and the reviewed routing in `.agents/memory/config.toml` and `config.md`.
Do not infer a project from the checkout name or another client's default.
Run local memory setup and validation from the consumer root:

```bash
node .agent-workflows/bin/agent-workflows.ts setup_memory --project . --claude-skills
node .agent-workflows/bin/agent-workflows.ts setup_memory --project . --claude-skills --check
```

Preserve `--share-config` on both commands when previously selected. Initial
routing setup still needs reviewed input; these refresh commands cannot supply
it. Memory declined means this procedure is not applicable.

### Review the connection scope

The [Claude Code MCP reference](https://code.claude.com/docs/en/mcp#mcp-installation-scopes)
describes three CLI configuration scopes: local is the default, stored under the project's path in
`~/.claude.json`; project uses the root `.mcp.json`; user uses `~/.claude.json`
across projects for that user on that machine. A user-scoped connection on one
machine does not configure another machine. Shared project configuration still
requires each machine's dependencies, credentials and applicable trust/approval.
For duplicate server names, the official MCP reference gives local, then project,
then user; the highest source's whole entry is used, and fields are not merged.
Verified in a temporary `HOME`: a local entry beat a user entry, and `claude mcp list`
reported the conflict with both endpoints. Project over user is documented but not
verified here: a project `.mcp.json` server needs interactive approval, and in the
non-interactive check the user entry stayed effective. Inspect the effective mapping
with `claude mcp get <server-name>` before assuming a shared entry is used. Claude
Desktop, Codex and other harness connections do not prove that the Claude Code CLI
has the same connection.

For an opted-in consumer (routing `[connection] clients` includes `claude`),
the helpers generate the project-scope entry instead: a git-ignored root
`.mcp.json` with an `mcpServers.<name>` HTTP entry rendered from the machine
profile — `Bearer ${VAR}` placeholder, never a value. A local-scope entry for
the checkout path or a `disabledMcpjsonServers` record in any settings file
shadows or disables it and is reported, never edited. Approval comes from
`enabledMcpjsonServers` or `enableAllProjectMcpServers` in user, managed, or
untracked local settings — committed `.claude/settings.json` entries apply
only once the workspace is trusted — or from a one-time interactive prompt
recorded per checkout in `~/.claude.json`. A pending approval is reported as
a warning, not a hard blocker: `claude -p` and Agent SDK sessions with the projectSettings source enabled load
project `.mcp.json` servers without the interactive prompt according to upstream.
This is not verified here: the recorded sandbox run retained the user entry.
The live pilot must check both `claude -p` and T3/SDK sessions without recorded approval.
Runtime-only sources (`--settings`, `--setting-sources`, permission modes)
cannot be inspected and are documented here as a limitation. Merging preserves
unrelated `.mcp.json` content, and a tracked `.mcp.json` is refused. See
[project-scope client connections](memory/connections.md).

Use the reviewed service endpoint or launch command and the configured Claude
server mapping, preserving authentication references without displaying secrets.
Inspect local configuration offline using the shared output allowlist first.
Do not start with `claude mcp list`: it health-checks all servers. Do not print
raw `get` output or configuration, which can contain headers. After resolving
the selected mapping and approving its destination, probe only that server in
a fresh session; defer if unrelated unreviewed connections would also start. Reuse a
matching entry. Verified: `claude mcp add` refuses a same-name entry in the same
scope (`MCP server ... already exists in local config`, exit 1), so a repeat add
creates no duplicate. A conflicting entry still needs review: stop and report it;
do not remove or redirect it.

An authorized connection change uses the installed CLI's syntax, checked with
`claude mcp add --help`: `--transport http` (or `-t http`), `--scope local|project|user`
(or `-s`), the server name, and the reviewed endpoint. `-H` is variadic, so put the
name and endpoint before it. For a bearer token, reference an environment variable
with the placeholder and keep the argument in single quotes so the shell does not
expand it:

```bash
claude mcp add --transport http --scope local <server-name> "<reviewed-endpoint>" \
  -H 'Authorization: Bearer ${BASIC_MEMORY_API_TOKEN}'
```

Claude Code stores the literal placeholder and expands it when it connects
(official MCP reference). Verified in a temporary `HOME` against a loopback listener
that received the expanded value on each request; the value was not printed. Choose
your own variable name. The reference lists credential names that read as empty in a
remote header (for example `ANTHROPIC_AUTH_TOKEN`), and an unset variable is sent
unexpanded with a warning. A double-quoted `"...${VAR}"` lets the shell write the
secret into the command and the config, so do not use it. This is a command
template, not authorization to modify client settings. Do not run it or change
global configuration as part of a routine toolkit refresh.

`claude mcp list` checks reachability (verified: an unreachable endpoint shows
`Failed to connect`). That is a network signal only; it does not show that the
Basic Memory tools work for a project.

### Fresh-session read evidence

After authorized connection setup, start a fresh `claude` session from the
consumer root and record `claude --version`, machine and checkout. Check:

1. Memory skills are discovered in the session via `.claude/skills` and the
   intended routing instructions are loaded. This is discovery evidence only.
2. The local helper's `--check` result above. This validates local artifacts.
3. In `/mcp`, inspect the intended server's availability. A listed or connected
   server alone does not prove project access. Ask Claude to use that server's
   native read/search tool with the explicit configured project and read scope.
   Retrieve a known permitted note if available; otherwise record a successful
   empty query as such. Record the tool, project, scope and actual outcome,
   without note contents or credentials that need not be shared. Do not create
   a note or schema as a connection test.

Apply the shared [readiness reporting contract](../.agents/skills/setup-basic-memory/references/readiness-reporting.md).
Missing connection means **memory readiness incomplete** and live access and
retrieval unverified, while successful local installation remains passed.
If native tools are unavailable in the active harness, report that limitation
and hand off verification to a fresh Claude Code session; do not substitute
another client's successful read. A failed read records the actual error and
scope, without claiming the project is empty or the connection is absent.

### Connection handoff

When configuration needs separate authorization, provide this concrete handoff
with observed values filled in; keep unresolved inputs explicit:

> In `<consumer-root>` on `<machine>`, Claude Code `<version>` has memory
> readiness incomplete: `<missing connection / unavailable tools / read error>`.
> The recorded capability is `<choice>`; preserve routing for `<project>` and
> `<read scopes>` using server mapping `<name>` and service/launch reference
> `<non-secret reference or unresolved input>`. Local setup/check evidence is
> `<command and outcome>`; skill discovery is `<evidence or unverified>`.
> Proposed connection scope is `<local/project/user with reason>`; the exact
> configuration change `<reviewable command or unresolved requirement>` needs
> authorization before execution. Then start a fresh Claude session here and
> perform only a native project-scoped read, recording its result separately.

### Verification evidence for this guidance

Linux validation used Claude Code 2.1.312. Checks covered help output and
temporary configurations for HTTP registration, duplicate names, unreachable
endpoints, local-over-user precedence, and environment-variable expansion in
headers. Approved project-over-user precedence and live reload were unverified.
Use the fresh-session procedure above to verify a native read in your project.
