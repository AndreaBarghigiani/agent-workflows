# Basic Memory 1.0 compatibility contract

This page records which combinations of Basic Memory server, memory skills and
client state work together, and the order in which to change them. Use it as
the preflight reference before upgrading a shared service or updating a consumer.

Each statement is marked **observed** (run during this review) or **documented**
(stated by upstream, not run here). Observed checks used disposable local
services over stdio with synthetic notes. They are not evidence about any
deployed service, HTTP transport, or a particular client.

## Reviewed sources

Reviewed on 15 November 2026 from
[`basicmachines-co/basic-memory`](https://github.com/basicmachines-co/basic-memory).

| Item | Revision | Notes |
|---|---|---|
| Pre-1.0 server | `v0.23.2`, commit `c0bd87c`, 25 August 2026 | Legacy tool names |
| Pre-1.0 skills | commit `d1f5c52`, 9 October 2026 | After `v0.23.2`, before `v0.24.0`; teaches legacy tool names |
| Security release | `v0.24.1`, commit `1d0e09b`, 23 October 2026 | Legacy tool names; includes the 0.24 security fixes |
| Stable 1.0 | [`v1.0.0`](https://github.com/basicmachines-co/basic-memory/releases/tag/v1.0.0), commit `c9bd187`, 29 October 2026 | `bm_*` tools |
| Development head | `main` at `c853f5f`, 15 November 2026 | Unreleased 1.1 work; renames tools again |

Upstream references: the
[1.0 migration guide](https://docs.basicmemory.com/reference/migrating-to-1-0),
`docs/1.0.md` and the `tools-migration(7)` manual page at the `v1.0.0` tag.

## What changed in 1.0

- **Tool names.** 1.0 registers twelve tools: `bm_context`, `bm_delete`,
  `bm_edit`, `bm_find`, `bm_list`, `bm_man`, `bm_move`, `bm_project`, `bm_read`,
  `bm_schema`, `bm_search` and `bm_write`. 0.23.2 registers none of them, and
  1.0 registers none of the 0.23.2 names. (observed)
- **No alias window.** A legacy name called on 1.0 returns `Unknown tool`, and
  a `bm_*` name called on 0.23.2 does the same. (observed) Upstream states that
  legacy registrations are "removed immediately, with no compatibility aliases
  or transition window". (documented)
- **Diagnostics.** `basic_memory_diagnostics` does not exist on 1.0. (observed)
  Upstream names `bm doctor` and `bm config list`, run in a shell on the server
  host, as the replacement. (documented) Reading the server version after an
  upgrade therefore needs host access, not an MCP call.
- **Project scope.** `project` accepts a name or a `workspace/project`
  qualified name; `project_id` is gone. A qualified name resolved on a local
  1.0 service. (observed) External UUIDs are also accepted. (documented)
  Search without `project`, `projects` or `all_projects` is refused with
  `INVALID_ARGUMENTS`. (observed)
- **Refusals.** Refusals set MCP `isError` and return `NOT_FOUND`,
  `ALREADY_EXISTS` or `REVISION_CONFLICT` with a `try_instead` hint. An
  unknown project returns a plain `Project not found` error. (observed)
- **Guarded overwrite.** Read the note as JSON, then write with the returned
  `file_path` as `identifier` and the read `checksum` as `expected_checksum`.
  A stale checksum is refused with `REVISION_CONFLICT` and nothing is written.
  (observed)
- **Receipts.** Write, move and delete receipts report `action` (`created`,
  `updated`, `moved`, `deleted`) with `file_path` and `checksum`. (observed)
- **Schemas.** `bm_schema(command="validate")` on a project with no schema, or
  for a note type with no schema, is refused with `NOT_FOUND`. It is not an
  empty success. `infer` works without a schema. (observed)
- **Notes.** Markdown notes written by 0.23.2 were read unchanged by 1.0,
  including frontmatter, observations, relations and `memory://` permalinks.
  File checksums were identical before and after the upgrade. (observed)

Upstream's development head has already split `bm_project` into
`bm_project_list`, `bm_project_create` and `bm_recent`, and `bm_schema` into
`bm_schema_validate`, `bm_schema_infer` and `bm_schema_diff`, again with no
aliases. Upstream plans to release this as 1.1.0. (documented) Those names
return `Unknown tool` on 1.0.0. (observed)

## Compatibility matrix

Skills are identified by the upstream revision they were installed from.

| Server | Skills | Result | Evidence |
|---|---|---|---|
| 0.23.2 | Pre-1.0 (`d1f5c52`) | Works. Tool names match. | observed (tool list) |
| 0.23.2 | `v1.0.0` | Fails. Every `bm_*` call is an unknown tool. | observed |
| 0.24.1 | Pre-1.0 (`d1f5c52`) | Expected to work; legacy names. | documented |
| 1.0.0 | Pre-1.0 (`d1f5c52`) | Fails. Every legacy call is an unknown tool. | observed |
| 1.0.0 | `v1.0.0` | Works. Names and arguments match. | observed |
| 1.0.0 | Upstream `main` (1.1 development) | Partly fails. Project discovery, recent activity and schema calls are unknown tools. | observed |
| Any | Any, with a client holding a cached tool list from the other server version | Unknown. Upstream says to restart clients to refresh cached schemas and permission lists. | documented |

A client is compatible only after a fresh session lists the tools of the server
it is connected to. Tool permission allowlists that name legacy tools need the
same update. Client behaviour was not tested in this review.

The four memory skills must come from the same release as the server. Upstream's
recommended command, `npx skills add basicmachines-co/basic-memory/skills`,
installs from the development head. Pin the release instead:

```bash
npx skills add basicmachines-co/basic-memory@v1.0.0 \
  --skill memory-notes --skill memory-capture \
  --skill memory-continue --skill memory-schema
```

Both `@v1.0.0` and a full pre-1.0 commit installed the matching skill text with
Skills CLI 1.8.1. (observed) The CLI records the source, ref and content hash
in `skills-lock.json`.

## Data and rollback

| Step | Result | Evidence |
|---|---|---|
| Start 1.0.0 on a 0.23.2 state directory and notes | Starts, migrates the index, reads and searches existing notes. Notes are not rewritten. | observed |
| Start 0.23.2 on a state directory that 1.0.0 has opened | Does not start: `Can't locate revision identified by '0042'`. | observed |
| Start 0.23.2 on the pre-upgrade index copy with notes written by 1.0.0 | Starts. The first read returned the older content; the newer content appeared after the file sync ran. | observed |
| Start 1.0.0 with notes and `config.json` only, no index | Rebuilds the index. Content, permalinks and scoped search are restored. Project and note external UUIDs are new. | observed |

Consequences:

- The index migration is one-way. Rolling back the server version needs either
  the index copy taken before the upgrade, or a rebuild from notes.
- A notes-only backup restores content and permalinks but not external UUIDs.
  Back up the state directory too if anything depends on those UUIDs. Routing in
  this library uses project names, and notes link by permalink.
- Markdown written after cutover survives a version rollback, because notes are
  files. Treat the index as rebuildable and the notes as the record.

## Upgrade order

There is no combination in which old and new parts overlap safely, so the
change is a single maintenance window per service.

1. **Recovery first.** Have a verified backup and a tested restore of notes
   and configuration before touching the service.
2. **Freeze writes.** Ask every agent and person using the service to stop
   writing. Finish or hand off open captures.
3. **Snapshot with the service stopped.** Copy notes, configuration and the
   index. Keep the previous image or version pin.
4. **Upgrade the server** to the reviewed release and confirm its version on
   the host.
5. **Replace the skills** in each consumer with the matching release.
6. **Restart every client** so it lists the new tools, and update any tool
   permission allowlist.
7. **Verify per consumer** in a fresh session: project discovery, a scoped
   search, an exact read, and, where writes are authorized, one guarded capture
   and recapture on a test note.
8. **Lift the freeze** only for consumers that passed step 7.

A consumer whose skills are not yet replaced must not use memory after step 4.
Its calls fail outright; they do not write to the wrong place.

## Stop and rollback conditions

Stop before the upgrade when the restore has not been tested, the snapshot is
incomplete, or any writer cannot be reached to confirm the freeze.

Roll back when the upgraded server does not start, existing notes cannot be
read by exact path, scoped search returns results from another project, or the
index fails to rebuild.

To roll back: stop the service, restore the previous version pin and the
pre-upgrade index copy, keep the current notes, start the service, and wait for
the file sync before trusting reads. Then restore the previous skills in each
consumer and restart clients. Reverting a consumer cannot undo notes written to
the service.

## Not verified here

- Any deployed service, its image, storage layout or backups.
- HTTP transport and reverse-proxy behaviour.
- Whether a specific client caches tool lists across sessions.
- Semantic search and embedding rebuild time on a real corpus.
- Upgrading through 0.24.1 rather than directly from 0.23.2.
