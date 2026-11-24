# Native memory capture and resume

The agent uses Basic Memory's native MCP tools and Basic Memory's own skills,
which each project [installs from upstream](upstream-skills.md) at its server's
release. It can capture
useful state during work or at handoff; no custom Stop hook or evidence runner is
required. The client must connect to the same Basic Memory service on each machine.

## Example: Linux to Mac

1. On Linux, the agent finishes a focused FAQ rendering check. It uses
   `memory-capture` to save a coherent note: what changed, the observed check result,
   remaining browser walkthrough, issue reference and useful checkout provenance.
2. It searches for an existing note for the current thread/topic, reads it if found,
   and creates or updates the note through native MCP tools in `example-app`.
3. When verifying persistence, it reads the returned exact note back. It reports
   an unsaved handoff if MCP is unavailable; it does not claim a local note is shared.
4. On Mac, a fresh agent uses `memory-continue` to search the same project and read
   the relevant note, then compares its context with the current code before work.

The note moves through MCP; code still moves through Git. A note about a Linux
change does not make that change present on Mac. Both clients need independent
working connections, but neither needs a NAS mount.

## Example requests

> Use memory-capture to save where this investigation landed, including the
> confirmed result, remaining uncertainty and next step.

> Use memory-continue to resume the FAQ investigation in example-app. Compare
> the prior note with this checkout before continuing.

> Use memory-notes to record the decision to use one shared MCP service.

## What happens during recapture

The upstream capture skill finds the same thread note and rewrites it coherently
to reflect current understanding. It does not create an immutable checkpoint at
every milestone. Read the existing note first and retain significant changes in
context where useful. Use an actual current thread ID when available, otherwise
match by topic. Do not overwrite another task's note just because its title is close.

The consumer's `.agents/memory/config.md` supplies explicit scopes and development evidence rules. It
keeps GitHub Issues authoritative; do not install upstream's `memory-tasks`.

## Client and schema differences

Native MCP tools supply search, read, write and context operations. Their names
and arguments depend on the server's release, and a release removes old names
without aliases; see the [compatibility contract](compatibility.md). Inspect the
live schemas: the installed service may not support every upstream example's
optional filters. Use supported topic search/read when a filter is unavailable,
and disclose limitations. Do not fabricate a wrapper or auto-run a CLI transport.

This library does not configure client-specific automatic hooks. Existing custom
Stop registrations must be retired during [migration](migration.md). Upstream
capture/resume instructions are available on clients that can discover the selected
skills and access the service; verify those abilities in each intended client.

## Failure behavior

If a write is refused because the note changed since it was read, read it again,
merge, and write with the new checksum. If a write times out, inspect the
original note through native search/read before another write. An empty search index is not proof of absence; report unresolved
persistence instead of blindly retrying. If no connection is available, include the
unsaved summary in the session handoff. There is no custom local receipt or replay
engine; do not claim the removed safeguards still operate.

Existing historic checkpoints remain ordinary readable Basic Memory notes. We do
not delete or rewrite them as part of simplifying this library.
