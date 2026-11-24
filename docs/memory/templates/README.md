# Memory templates

These templates document the retired custom capture system. New setup uses upstream
Basic Memory note/capture skills; no checkpoint template is required. See the
[native guide](../lifecycle-guide.md).

Copy and fill a template; do not publish literal `{{...}}` placeholders. Use UTC
ISO 8601 timestamps, YAML-escape substituted strings, and mark unknown provenance
explicitly. `workflow_kind` is `checkpoint`, `decision`, or `debugging`;
`status` is `current` or `superseded`. Persistence lives in a local receipt, not
in the claim's status. These are workflow conventions, not an installed Basic
Memory schema. The [policy](../policy.md) defines limits and promotion rules;
[configuration](../configuration.md) defines destination and capture IDs.

Basic Memory supports YAML frontmatter, categorized observations, and wiki-link
relations. Use `type: note`, a unique title/permalink, and custom provenance
fields; `created`/`modified` represent note chronology, not replay time.
See [official knowledge format](https://docs.basicmemory.com/concepts/knowledge-format).
Preserve explicit project plus identifier/path for cross-project provenance.

File mode writes the complete Markdown. For MCP capture, the stage 3 adapter maps the body,
title, tags, and extra metadata to the discovered `write_note` schema; do not
pass a second YAML header inside the body. Preserve capture identity and record
the returned identifier/path. Read back all required provenance. Consult the
[official tools reference](https://docs.basicmemory.com/reference/mcp-tools-reference)

Replace `unknown` when the value is observed; otherwise explain the gap in the
body. For promoted shared notes, `source_project` remains the original project
and `destination_project` is `shared-engineering`. Reference the source note,
its commit/issue/session, and evidence instead of asserting a source-free lesson.
No full transcripts or raw secrets. Links to unavailable artifacts are evidence
gaps and should be named as such.

The [stage 4 lifecycle helper](../lifecycle.md) renders this checkpoint schema
from selected verified command evidence and a structured session handoff; it does
not promote debugging/decision claims. Helper tests alone do not prove automatic
client capture. Custom weekly consolidation has been retired; retain original
evidence and chronology when explicitly correcting notes.
