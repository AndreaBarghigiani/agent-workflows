# Skill distribution policy

Skills in this library reach consumers in one of two modes. The mode is recorded
in a skill's `SKILL.md` frontmatter; the installer reads it, so no separate
selection list exists to fall out of sync.

## Release versioning

Releases use semantic version names. MAJOR versions mark consumer-breaking
changes, including installer contract or managed-block format changes, skill
removals or renames, and migrations required of consumers. MINOR versions add
skills or features. PATCH versions contain fixes and documentation changes.
The `0.x` series signals that the library's interfaces are still unstable.

At a PR merge considered stable for consumption, create an annotated version
tag on `main`. Do not tag every commit. Consumers continue to pin exact SHAs;
tags and `git describe --tags` provide a readable name for a pinned revision.
A complete GitHub release also publishes readable release notes for that tag;
prepare the tag and publication together and obtain explicit approval before
either action. Tag-only delivery remains available when explicitly requested.
See [the changelog](../CHANGELOG.md) for the issues included in each version.

## The versioned toolkit contract

Every consumer receives the standard toolkit defined by its pinned agent-workflows
version. Consumers do not select individual skills: installation, read-only
checks, updates, and optional T3 checkout preparation all derive the same
expected skill set by scanning the pinned library's `.agents/skills` frontmatter.
Installed links and reference-only pointers follow the distribution rules below.
The only consumer-level choice is whether the optional Basic Memory capability is
enabled, recorded in the consumer root as
`.agent-workflows-capabilities.json` with
`{"schema_version": 1, "memory": "enabled" | "declined"}`. That file records
capability choices only; it is never a skill-selection manifest.

The memory capability is defined once in the library (`MEMORY_SKILLS` in
`scripts/install.ts`) and holds the library's own `setup-basic-memory` skill.
When memory is declined, that skill is excluded from the installed set and from
reference-only pointers, and the consumer receives no memory routing,
configuration, managed memory instructions, or memory-specific guidance; it
requires no MCP access. When memory is enabled, `setup_memory.ts` installs
`setup-basic-memory` and the routing artifacts. Missing routing alone never
establishes a decline, and noninteractive helper use never enables memory while
the choice is unknown.

## Third-party skills

The library does not ship other projects' skills. Basic Memory's skills are
installed by each memory-enabled consumer from upstream, pinned to its server's
release; see [installing Basic Memory's skills](memory/upstream-skills.md).

The installer leaves third-party skills alone: a real directory in
`.agents/skills`, or a link that points outside the pinned library, is never a
conflict unless it occupies the name of a library skill. Up to version 0.2.1
the library linked four vendored Basic Memory skills. The installer removes
those links only when they are broken and point into the pinned library, and
`--check` reports them with the repair command. Retired library skills get the
same link retirement plus content-proven copy removal; see
[retired skills](#retired-skills).

In the library's own checkout, skills named in the root `skills-lock.json` are
excluded from the toolkit and from validation, so an upstream install there is
not distributed to consumers.

### Adopted third-party skills

Vendor installers such as `npx skills add …` copy a skill into each harness
folder they support (`.claude/skills`, `.codex/skills`, `.opencode/skills`, …).
The `adopt-skills` skill and its `scripts/adopt_skills.ts` helper consolidate
those copies into the same layout the toolkit uses: the skill exists once as a
real `.agents/skills/<name>` directory, and every discovered hidden
`.*/skills` folder that cannot read `.agents/skills` natively gets a relative
symlink through the same link helpers `install.ts --claude-skills` uses.
Codex and OpenCode read `.agents/skills` natively, so their copies are removed
without a link; unknown folders default to a link so an adopted skill never
silently stops loading.

Copies are compared by content, never by name alone. The helper refuses —
reporting without writing for that skill — when copies differ, when a copy
differs from an existing `.agents/skills/<name>` that is not the last adopted
revision, when the name clashes with a pinned toolkit skill, or when a copy
contains internal symlinks or special files. No copy is removed before the
canonical skill exists. The default mode is a dry run; `--apply` performs the
plan, and a manifest in `.agents/adopted-skills.json` records the original
paths, content hash, adoption date, frontmatter `source`/`version` fields and
an optional redacted source command for each adopted skill. That manifest
also lets a rerun detect vendor re-installs as drift and re-adopt identical
copies, and it fills in links when a new harness folder appears later.
Whether adopted skills and the manifest are tracked or git-ignored is the
consumer's decision; adoption stages nothing.

## Retired skills

Removing a skill from the toolkit is a consumer-breaking change under the
release versioning policy. On refresh, the installer retires only state it can
prove is toolkit-owned, never by name alone: a broken link in `.agents/skills` or a contained hidden harness `.*/skills`
folder resolving to the retired path inside the pinned library,
and — for skills this library shipped itself — a real directory whose complete
file set matches the retired content recorded in `scripts/install.ts` and has
neither an adoption record nor incoming harness links. Copies with either are
preserved together with their provenance and links for an owner decision;
unreadable adoption provenance also prevents copy removal. Each
removal prints a `retired:` line and `--check` reports the entries with the
repair command. Same-name content that is not proven toolkit-owned — a
customized copy, a differing or incomplete directory, a link outside the
retired path, or an unrelated skill installed by another tool — is preserved
and reported with a `preserved:` diagnostic; removing it is a reviewed owner
decision. Consumer-authored integration references, indexes, `AGENTS.md`
pointers and client configuration are untouched, and returning to a pin that
still ships a retired skill restores it through the normal derived toolkit.

This currently covers `add-integration` and `use-integration`, retired after
0.4.1; see [integration references](integrations.md#retired-integration-skills)
for the consumer-facing migration notes. The four vendored Basic Memory skills
retired in 0.3.0 use the link half of the same mechanism — their content is
third-party, so no content proof applies.

## Installed (default)

A skill without a `distribution` field is installed: the library helper creates
`.agents/skills/<name>` as a relative symlink into the consumer, so harness skill
discovery finds it directly. Recurring-procedure skills are installed; this is
the ordinary path and is not changed by reference-only distribution. Skills
that owners may invoke repeatedly to refresh consumer-owned configuration also
belong here, even when each invocation produces a durable artifact.

Claude Code reads project skills only from `.claude/skills`. With the opt-in
`--claude-skills` flag the helper mirrors the same installed links there; the
toolkit set does not change. See [Claude Code setup](claude.md).

When the project is the library repository itself (resolved source equals
resolved project), each real `.agents/skills/<name>` source directory is
already its own managed destination. Install and `--check` report it as
`self:` rather than `installed:` or `linked:`, and reference-only pointers
use repo-relative paths. Every refusal applies unchanged: a symlink at a
managed path resolving elsewhere, and customized or malformed managed
blocks.

## Reference-only ("shared, not installed")

A skill marked `distribution: reference-only` is never copied or linked into the
consumer's `.agents/skills`. Instead, the installer maintains a short, managed
pointer block in the consumer's root `AGENTS.md`, alongside collaboration
guidance:

```text
<!-- agent-workflows:reference-only:start -->
## Shared, not installed
...
- tailscale-web-dev: `.agent-workflows/.agents/skills/tailscale-web-dev/SKILL.md`
<!-- agent-workflows:reference-only:end -->
```

The block lists each reference-only skill in the derived toolkit and points to
its `SKILL.md` at the pinned revision, using a library-relative path from the
consumer root. An agent adopts such a skill by reading that file
when the task matches, not by activating an installed skill.

Warning: discovery depends on the pointer existing. If the pointer block is
removed from `AGENTS.md`, the skill becomes invisible to normal instruction
loading even though the library checkout is still present. Preserve the block;
the installer refuses customized or malformed blocks, exactly as it does for the
other managed policies. A read-only `--check` names the missing block and its
markers; rerunning the installer restores a missing block, while customized or
malformed blocks need a reviewed edit, never an overwrite.

## One-shot criteria

A skill is reference-only when it is a one-shot setup procedure:

- It produces a durable artifact (configuration, service registration, or
  standing route) rather than guidance applied during the task itself.
- It is needed once per project; once adopted, the artifact persists and the
  procedure is rarely repeated as providers, subscriptions, or available models
  change.
- It is not part of recurring task routing; no ordinary task should invoke it
  through skill discovery.

Currently this covers `tailscale-web-dev`. Other skills default to installed. `configure-delivery-profiles` is installed because
owners can rerun it to refresh their consumer-owned provider and model choices
as connected harnesses and subscriptions change. The read-only
`inventory-delivery-capabilities` skill is also installed so owners can request
that snapshot on its own; `configure-delivery-profiles` reuses the same
inventory procedure before presenting configuration choices.

## Consumer ownership

The pointer text and any commands the skill prescribes act in the consumer's
environment and belong to the consumer once adopted. Setup and update helpers
maintain only the managed block itself; they do not uninstall reference-only
skills retroactively, rewrite consumer integration docs, or change services the
procedure configured.
