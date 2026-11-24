# Installing Basic Memory's skills

This library does not ship Basic Memory's skills. Each memory-enabled project
installs them from the [Basic Memory repository](https://github.com/basicmachines-co/basic-memory/tree/main/skills),
at the release that matches the server the project connects to. The library
supplies routing and setup guidance only: `setup-basic-memory` and the
generated `.agents/memory/config.md`.

## Why the release must match

Tool names and arguments differ between Basic Memory releases, and old names
are removed without aliases. A skill written for one release calls tools that
another release does not have. The
[compatibility contract](compatibility.md) lists the combinations that work.

Upstream's documented command, `npx skills add basicmachines-co/basic-memory/skills`,
installs from the development branch. That branch can be ahead of the latest
release, so do not use it unpinned.

## Install

Run this from the project root, replacing the tag with the server's release:

```bash
npx skills add basicmachines-co/basic-memory@v1.0.0 \
  --skill memory-notes --skill memory-capture \
  --skill memory-continue --skill memory-schema
```

Install per project, without `-g`. A user-level install would expose the
skills to projects that declined memory or that connect to a different server.

The [Skills CLI](https://github.com/vercel-labs/skills) asks which agents to
install for, or takes `--agent`. It writes:

- `.agents/skills/<name>/` with the skill files;
- a link per skill in each selected agent's own folder, such as
  `.claude/skills/<name>`;
- `skills-lock.json` in the project root, recording the source, the ref and a
  content hash for each skill.

Whether to commit these files is the project's choice. Committing
`skills-lock.json` records which release the project expects.

`memory-tasks` is left out because GitHub Issues remains the task tracker.
Other upstream skills are the project's own decision.

To move to another release, run the same command with the new tag; it
overwrites the installed copies and updates the recorded ref. Do it in the same
change as the server upgrade, then restart each client so it lists the new
tools, and update any tool permission list that names the old ones. Do not use
`npx skills update` for these skills unless the server is being upgraded to
upstream's latest in the same change.

## Tested versions

| Server | Skills ref | Skills CLI | Result |
|---|---|---|---|
| 1.0.0 | `v1.0.0` | 1.8.1 | Installs; tool names match the server |
| 0.23.2 | commit `d1f5c5265254de258fd928228291c261fb4c99b6` | 1.8.1 | Installs; tool names match the server |

Tested on 15 and 16 November 2026 with project installs for Claude Code and
Codex and disposable local servers. Re-installing at another ref, installing
over broken library links, and `npx skills remove` were also run. No other
combination is claimed.

## Projects that used the vendored copies

Library versions up to 0.2.1 linked `memory-notes`, `memory-capture`,
`memory-continue` and `memory-schema` from the pinned library. After updating
past that version:

1. Run the library installer, then `setup_memory.ts`, as for any update. The
   installer removes those links when they are broken and point into the
   pinned library. It prints one `retired:` line per link. It does not touch a
   real directory or a link that points anywhere else.
2. Setup replaces the generated `.agents/memory/config.md` when it is the
   unmodified earlier text. A customized file is reported and kept.
3. Install the upstream skills with the command above.

Do step 3 after the library update, not before: while the old links still
resolve they point into the pinned library. Between steps 1 and 3 the project
has no memory skills. `--check` reports
remaining retired links and names the repair command; it never removes them.

Going back to an older library pin works in reverse; the full steps are in
[updating a memory-enabled consumer](consumer-update.md#go-back). Remove the
upstream copies first, because the older installer refuses a real directory
where it expects its own link:

```bash
npx skills remove memory-notes memory-capture memory-continue memory-schema
```

## The library's own checkout

When this repository uses memory itself, the upstream skills land in the same
`.agents/skills` folder that holds the library's skills. The installer and the
validator skip every skill named in the root `skills-lock.json`, so they are
never distributed to consumers as library skills. The validator prints the
skipped names; a library skill must never appear in that list.
