# Standard Basic Memory Schemas

Seed these schema notes into each configured Basic Memory project through MCP.
These definitions standardize reusable project knowledge; they do not replace the
GitHub issue comment that records a specific issue's verified implementation.

Use the server's note-writing tool with `directory="schemas"`,
`note_type="schema"`, and the metadata below. The tool is `bm_write` on Basic
Memory 1.0 and `write_note` before it; confirm the name and arguments in the
deployed tool schema. The content is regular Markdown for people; Basic Memory reads the
schema from frontmatter metadata. Use `settings.validation: warn` so adoption can
be gradual.

## Decision

- Title: `Decision`
- Type: `schema`
- Entity: `decision`
- Version: `1`
- Metadata schema:

  ```yaml
  context: string, background and problem that led to the decision
  decision: string, the selected choice
  rationale: string, reasons for the choice
  status(enum, lifecycle status): [proposed, accepted, rejected, superseded]
  alternatives_considered?(array, alternatives evaluated): string
  consequences?(array, expected or observed outcomes): string
  source_issue_url?: string, GitHub issue that established or changed this decision
  supersedes?: Decision, earlier decision replaced by this one
  ```

- Note body guidance: one note per durable choice; keep status current and link a
  superseded decision when applicable. The issue comment remains the detailed
  implementation record.

## Pattern

- Title: `Pattern`
- Type: `schema`
- Entity: `pattern`
- Version: `1`
- Metadata schema:

  ```yaml
  problem: string, recurring problem this approach addresses
  when_to_use: string, conditions in which this approach applies
  approach: string, reusable solution or practice
  status(enum, current lifecycle status): [current, deprecated]
  constraints?(array, limits or prerequisites): string
  tradeoffs?(array, costs or alternatives to consider): string
  source_issue_url?: string, GitHub issue demonstrating or establishing the pattern
  related_decisions?(array): Decision, decisions that guide this pattern
  ```

- Note body guidance: keep patterns actionable and scoped to when they apply.
  Mark superseded practices as deprecated instead of silently reusing them.

## Note writing rules

- Store schema notes at `schemas/Decision` and `schemas/Pattern` in each project's
  Basic Memory space. They are Basic Memory notes, not repository documentation.
- Existing project-specific definitions take precedence. Read and compare before
  creating or revising anything; reconcile differences instead of overwriting.
- Schema fields are observations in typed notes, for example
  `- [decision] Use the shared credit ledger`; headings alone do not satisfy
  validation.
- Put a GitHub issue URL in `source_issue_url` when a decision or pattern was
  established or demonstrated by an issue. Do not create a duplicate issue note.
