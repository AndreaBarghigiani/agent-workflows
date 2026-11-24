---
name: update-agent-workflows
description: Adopt an explicitly reviewed agent-workflows revision, refresh an existing consumer installation, and land the pin through the consumer's authorized path. Use for routine pin updates, not initial setup or library source changes.
---

# Update agent workflows

Refresh an existing consumer's pin and toolkit installation after its target
revision is agreed. Read the consumer root `AGENTS.md`, relevant engineering
docs, the current library's setup instructions, and [the update procedure](references/update-procedure.md).
Use its [provider discovery and selection guidance](references/provider-selection.md)
when an update mentions an execution harness or provider.
Use the consumer's check guidance to resolve exact required commands, context
and scope. Preserve local work, recorded capability choices, routing and
overrides. A pin update
does not authorize editing shared-library source or another project.

The pinned dispatcher plans the refresh:

```sh
node .agent-workflows/bin/agent-workflows.ts update plan --json
```

It reads the pin, the library checkout, installed links and recorded
choices, then names the install flags and follow-up commands for this
checkout. It writes, stages and checks out nothing. With
`--target <rev>` it fetches that revision into the library from the
consumer's recorded submodule URL and names the URL; a partial clone may
also download missing objects from its own remote, as any Git command
does. A nonzero exit
means stop: report the plan's reasons to the owner and do not work around
them. Run the plan before changing anything and again after adopting the
target, so the destination revision's rules decide the flags. Show the owner
the exact planned pin and installation edits for review; accepting them
approves the refresh and — unless the owner asks to keep it local-only — its
scoped commit. The existing
`install`, `setup_memory`, `t3_readiness` and `memory_preflight` commands
remain the writes; run the ones the plan names only after the owner has
accepted the plan.

What stays with you and the owner, never the command: choosing the target
(an agreed reviewed revision, a tag resolved to its SHA, or an explicit
request for latest `main`), which authorizes the plan's fetch of it; the pin adoption, the
scoped commit and any repair; answering the plan's owner questions; reviewing
drifted policy text and migration notes; and the handoff. If target,
boundaries, or conflicts are ambiguous, stop before dependent mutation and
give the owner the evidence and a handoff choice. Keep the original branch
and local commits; never reset, clean, stash, force, or switch branches to
bypass a refusal, and never delete markers or bypass installer protection.
Existing links to skills the destination no longer ships are reported for
review, never silently deleted; the installer removes only what it can prove
and reports it with `retired:` or `preserved:` lines. For legacy memory
state use the specific [memory migration procedure](../../../docs/memory/migration.md).
The harness owns workspace binding and worktree lifecycle; see the
[fresh checkout guidance](../../../docs/worktrees.md).

The consumer-owned `.agents/delivery-profiles.json` is preserved byte-for-byte
on every update. When the plan offers it, ask the owner; on acceptance add
`--delivery-profiles`. After the update completes, give the same completion
explanation setup gives: what the file controls and that a missing or empty
file uses the shipped agent defaults, linking the documented example, schema,
and guided interactive flow in [delivery profiles](../../../docs/delivery-profiles.md).

T3 Code worktree setup is an independent opt-in; a routine refresh never
changes its recorded choice. For a separately requested enablement, use the
[T3 Code worktree setup guide](../../../docs/t3-checkout-readiness.md); it
does not require changing the pin.

Approval of the exact target and planned changes carries the routine update
through landing: the refresh, a scoped local commit of the gitlink and its
tracked refresh changes, and the consumer's authorized path — a pull request
where its branch rules require one, a direct push only where they permit it
and the owner authorized it. An explicit local-only request leaves the
refreshed result staged and uncommitted for inspection instead. Verification
that requires the committed pin uses the scoped commit; a failed required
check blocks landing and leaves the result for diagnosis. Follow the
consumer's branch rules; do not stage, commit, push or publish anything
outside the update's own paths, and do not update unrelated consumers without
authorization. Report old and new SHAs, the resulting diff and actual check
evidence; report the update landed only after the consumer's remote target
branch records the intended SHA.

Use the shared [installation and Basic Memory readiness reporting contract](../setup-basic-memory/references/readiness-reporting.md) for handoffs. Report observed local and live evidence separately; an update requires no live memory probe. A routine update preserves existing client MCP connections and never adds, removes, or re-scopes them; connection setup belongs to `setup-basic-memory`.

For Claude memory connection scope, fresh-session project reads, and an
authorization-aware connection handoff, follow [Claude Basic Memory guidance](../../../docs/claude.md#basic-memory-connection-and-verification). Keep discovery, local routing checks, and actual Claude access evidence separate.
