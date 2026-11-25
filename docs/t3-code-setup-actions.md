# T3 Code project setup actions

This reference records what is established about registering project scripts
(called project actions in the settings UI) for T3 Code. It separates scripts
stored on a project record from the effective action list used by a thread.

## Version and evidence boundary

On 2026-10-22, this environment reported T3 server version `0.1.1`. The
version-pinned source references below therefore match the observed server
version. The runtime findings come from one explicitly authorized disposable
project in this environment; they do not qualify every installation or
permission configuration.

The registered `Agent Memory` project matching this checkout was read only:
`t3_project_list` returned project ID
`a0dc34ee-9daf-4368-a452-e4e4d06a3c9c`, `scripts: []`, and `autoPull: false`.
It was not changed.

## What v0.1.1 source establishes

### Stored project scripts and effective action resolution

The project service accepts an optional `scripts` array in create/update
commands, stores that array on the project record, and returns it in
`Project.scripts`. The MCP `t3_project_read` result exposes this field. This is
project metadata; it is not the environment settings object used by the GUI's
project actions editor.

For a project, the v0.1.1 `resolveProjectScripts` function chooses the effective
action list in this order:

1. `projectSettingsOverrides[project.id].defaultProjectScripts`, when defined.
2. `defaultProjectScripts` when `projectSettingsFolded` is true.
3. The legacy `projectScriptOverrides[project.id]`; a `null` entry means use
   `defaultProjectScripts`.
4. Otherwise, non-empty `project.scripts`; if empty, use
   `defaultProjectScripts`.

The `t3.json` scripts are not another automatic resolution tier. The loader
reads and validates the repository-root file, and the UI presents eligible
entries as import candidates. An import adds the selected action to the
effective project list; generating or checking in `t3.json` alone does not
register a project-specific action.

### GUI save, permission and import behavior

The v0.1.1 GUI settings hook reads the current effective list, transforms it,
then writes project actions to
`projectSettingsOverrides[project.id].defaultProjectScripts`. It preserves
other keys in that same override object. The GUI checks `AuthSettingsWriteScope`
on each target environment before saving. The hook's in-process `savingRef`
prevents overlapping saves in that hook instance; the source does not establish
a server-side compare-and-swap guarantee across clients.

The MCP access guard separately marks `t3_project_update` as an environment
write. Source requires a live full-access/default calling thread or a
full-access client for this category. This is a source-established requirement,
not a qualification of the permissions granted to every client or thread; the
pilot below records only that its own metadata update succeeded. The MCP guard
and GUI `AuthSettingsWriteScope` are distinct permission checks.

The root `t3.json` contract supports a `scripts` array. For a setup action,
`runOnWorktreeCreate: true` requests execution after a worktree is created;
`async: false` maps to the GUI's wait-for-setup option. In the project actions
menu, v0.1.1 shows eligible entries under **From t3.json**. Selecting an entry
imports it through the GUI save path. Entries with the same command or a
case-insensitive matching name are filtered from the import candidates. This
is a user-mediated import, not a write API for project settings.

The setup selector returns only the first action with
`runOnWorktreeCreate: true`. When the GUI saves a new action with that role,
`releaseClaimedRoles` clears the role from an existing setup action. Therefore,
retaining an old action in the array does not retain its setup behavior. Before
adding a setup action, inspect existing creation-time actions and explicitly
decide whether to combine their commands or replace the existing role. A
consumer that opts into generated memory connections composes
`setup_memory_connections.py` into that single setup command — the library
ships the command, the consumer owns the action; see
[t3-checkout-readiness.md](t3-checkout-readiness.md).

Tagged sources:

- [useProjectScriptSettings.ts](https://github.com/pingdotgg/t3code/blob/v0.1.1/apps/web/src/components/settings/useProjectScriptSettings.ts)
- [ProjectService.ts](https://github.com/pingdotgg/t3code/blob/v0.1.1/apps/server/src/project/ProjectService.ts)
- [McpToolAccess.ts](https://github.com/pingdotgg/t3code/blob/v0.1.1/apps/server/src/mcp/McpToolAccess.ts)
- [projectScripts.ts resolver](https://github.com/pingdotgg/t3code/blob/v0.1.1/packages/shared/src/projectScripts.ts)
- [projectScripts.ts role handling](https://github.com/pingdotgg/t3code/blob/v0.1.1/apps/web/src/projectScripts.ts)
- [T3ProjectFileLoader.ts](https://github.com/pingdotgg/t3code/blob/v0.1.1/apps/server/src/project/T3ProjectFileLoader.ts)
- [ProjectScriptsControl.tsx](https://github.com/pingdotgg/t3code/blob/v0.1.1/apps/web/src/components/ProjectScriptsControl.tsx)
- [t3ProjectFile.ts](https://github.com/pingdotgg/t3code/blob/v0.1.1/packages/contracts/src/t3ProjectFile.ts)

## What v0.1.12 source establishes (checked 2026-11-25)

### Script identifiers take two routes

The server enforces the script-ID rule on project updates. For a new script id
forwarded to `planProjectCommand`, the run command `script.<id>.run` must match
`SCRIPT_RUN_COMMAND_PATTERN`: a literal `script.` prefix, a non-empty id of at
most `MAX_SCRIPT_ID_LENGTH` (24) characters matching
`/^[a-z0-9][a-z0-9-]*$/`, then `.run`. The rejection reads "Script IDs must be
1-24 lowercase letters, digits or hyphens, starting with a letter or digit (got
N characters)". A `t3.json` entry whose id reaches that update — for example
through `t3_project_update` — is refused when the id exceeds the limit.

The GUI import route differs. The `t3.json` contract (`T3ProjectFileScript`)
carries no `id` field, and **Import from t3.json** ignores an entry's `id`
entirely: it derives the action ID from the action name, truncated to 24
characters — `Agent workflows checkout readiness` becomes
`agent-workflows-checkout`. An effective action's ID can therefore differ from
the `id` recorded in `t3.json`.

Tagged sources:

- [ProjectCommands.ts](https://github.com/pingdotgg/t3code/blob/v0.1.12/apps/server/src/orchestration-v2/ProjectCommands.ts)
- [keybindings.ts](https://github.com/pingdotgg/t3code/blob/v0.1.12/packages/contracts/src/keybindings.ts)
- [t3ProjectFile.ts](https://github.com/pingdotgg/t3code/blob/v0.1.12/packages/contracts/src/t3ProjectFile.ts)
- [ProjectScriptsControl.tsx](https://github.com/pingdotgg/t3code/blob/v0.1.12/apps/web/src/components/ProjectScriptsControl.tsx)
- [projectScripts.ts](https://github.com/pingdotgg/t3code/blob/v0.1.12/apps/web/src/projectScripts.ts)

## Successor installation handoff

For this private library, a successor installer can generate a repository-root
`t3.json` containing the setup script, then direct the user to import it from
the T3 Code project actions menu. A Python generator and the manual import are
reasonable to prototype; the file alone does not register an effective action.
The import UI is confirmed in v0.1.1 source, while this pilot could not exercise
the desktop UI. Do not claim unattended registration through
`t3_project_update({scripts: ...})`: it wrote project metadata but did not run
the setup action in the fresh worktree. Do not use internal persistence or
undocumented writes.

Before applying an update to an existing project:

1. Read its current actions and settings immediately before mutation. Compare
   them with the captured baseline; stop and reconcile if they changed.
2. Inspect every existing `runOnWorktreeCreate` action. The UI releases this
   role from existing actions when another one claims it, and the runtime
   selector chooses only the first marked action. Preserve behavior by
   composing commands or obtaining an explicit replacement decision.
3. For `t3_project_update`, merge into the complete current `scripts` array and
   send that full array. Re-read after the write. Repeating the same full array
   was stable in the disposable pilot, but cross-client concurrency is not
   protected.
4. For the supported `t3.json` route, generate the file, open the project's
   actions menu, select the entry under **From t3.json**, then confirm it
   appears in the effective project actions list. Keep file generation,
   user import, and runtime execution as separate verification steps.
5. Verify `runOnWorktreeCreate` and `async: false` in a fresh worktree on the
   target version before claiming synchronous setup. This runtime pilot failed
   that check for the project metadata path.

Suggested successor issue: build a small Python generator for the shared
`t3.json` action reference and test the supported manual import on an
authorized disposable project. Confirm the imported action appears in the
effective settings, preserves existing settings and creation-time behavior,
and executes synchronously in a fresh worktree. Investigate a supported API for
the effective override and read-back only if T3 exposes one. Keep consumer
rollout separately authorized.
