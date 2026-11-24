---
name: adopt-skills
description: Consolidate identical third-party skill copies from harness folders into a single `.agents/skills/<name>` with links where needed. Use when the owner asks to adopt skills after installing them with a vendor tool; the skill never runs vendor installers.
---

# Adopt skills

Use when the owner asks to "adopt skills" after installing third-party skills
with a vendor tool (for example `npx skills add …` or `npx @aiforui/install`).
The owner runs the vendor installer beforehand; this skill never installs
anything and never handles vendor tokens. All filesystem work is done by the
deterministic helper `scripts/adopt_skills.ts` in the pinned library (usually
`.agent-workflows/scripts/adopt_skills.ts`). See
[skill distribution](../../../docs/skill-distribution.md) for the policy.

The helper scans hidden first-level `./.*/skills/` folders (excluding
`.agents`, `.agent-workflows` and `.git`), skips entries that are already
links, and consolidates identical copies into `.agents/skills/<name>`.
Folders whose harness reads `.agents/skills` natively (Codex `.codex/skills`,
OpenCode `.opencode/skills`) lose their copy; every other discovered folder
gets a relative symlink so the skill keeps loading. Differing copies, toolkit
name clashes, unsafe entries (internal symlinks, special files) and copies
differing from an existing `.agents/skills/<name>` are refused, never merged
or deleted. No copy is removed before the canonical one exists.

## Procedure

1. **Plan.** From the consumer root, run the dry run and show the owner the
   planned adoptions, removals, links, conflicts and refusals:

   ```bash
   node .agent-workflows/bin/agent-workflows.ts adopt_skills --project .
   ```

   Confirm before applying. A refusal is a report, not a failure: present it
   with the evidence (which copies differed, which name clashed) and let the
   owner decide; never force or hand-merge copies.

2. **Provenance.** Ask exactly one optional, skippable question: which command
   installed the skills (for example `npx skills add …`). If the owner
   answers, pass it as `--command`; the helper redacts `--token=` and other
   secret-looking values before recording. Do not ask for tokens, and ask
   nothing else.

3. **Apply.** On confirmation:

   ```bash
   node .agent-workflows/bin/agent-workflows.ts adopt_skills --project . --apply \
     [--command "<install command>"]
   ```

4. **Report.** Summarize adopted, updated, deduplicated and linked skills,
   refusals and conflicts, and the recorded provenance in
   `.agents/adopted-skills.json`. Whether adopted skills and the manifest are
   tracked or git-ignored is the consumer's decision; this skill stages and
   commits nothing.

Rerunning is safe: a vendor re-install that recreates identical copies is
re-adopted (drift is detected through the recorded hash and reported as
`updated`), and a run with nothing to do changes nothing.
