/**
 * `update plan` — plan a consumer pin refresh from the pinned dispatcher
 * (issue #119).
 *
 * Pure reads only: the plan inspects the consumer's recorded pin, the
 * pinned library checkout, installed links and recorded capability
 * choices, then names the install flags and follow-up commands for that
 * checkout. It never writes, stages, fetches or checks out; `install`,
 * `setup_memory`, `t3_readiness` and `memory_preflight` stay the writes
 * the owner runs after accepting the plan.
 *
 * `plan()` classifies the same unsafe checkout states `consumer_pin`
 * refuses — into data rather than exceptions — so a stopped plan still
 * says why and what the owner must resolve.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GitResult } from './lib/git.ts';
import { pyJsonLoads } from './lib/pyloads.ts';
import { pyRepr } from './lib/pyrepr.ts';
import { readText } from './lib/pyio.ts';
import {
  CAPABILITIES_FILE,
  CLAUDE_SKILLS,
  COLLAB_BLOCK,
  COLLAB_END,
  COLLAB_START,
  DELIVERY_PROFILES,
  MEMORY_SKILLS,
  REF_END,
  REF_START,
  RETIRED_MEMORY_SKILLS,
  RETIRED_TOOLKIT_SKILLS,
  SKILLS_LOCK,
  apply_policy_blocks,
  compareCodePoints,
  is_reference_only_text,
  link_status,
  prepare_claude_import,
  pyResolve,
  read_capabilities,
  reference_block,
  remove_legacy_worktree_block,
  repair_command,
  shlexQuote,
  third_party_skills,
  third_party_skills_text,
  toolkit,
} from './install.ts';
import type { ClaudeImport, Plan } from './install.ts';
import { ValueError, osErrorName } from './lib/pyerrors.ts';
import {
  CONNECTION_PATHS,
  connectionClients,
  defaultProfilePath,
  jsonDumps,
} from './memory_connections.ts';
import {
  expected_instructions,
  setup_preflight,
} from './setup_memory.ts';
import {
  BOOTSTRAP as T3_BOOTSTRAP,
  BOOTSTRAP_MJS as T3_BOOTSTRAP_MJS,
  CONFIG as T3_CONFIG,
  legacy_id_action,
  python_era_action,
  validate_config as validateT3Config,
} from './t3_readiness.ts';

// --- Planner git ---------------------------------------------------------------

/** `text=True` universal-newlines decoding (same contract as lib/git.ts). */
function universalNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Upper bound for one planner Git call, the `--target` fetch included. */
const GIT_TIMEOUT_MS = 300_000;

/**
 * Planner git. Reads, plus the one `--target` fetch. It never stages,
 * checks out or rewrites the index: `--no-optional-locks` and
 * `GIT_OPTIONAL_LOCKS=0` keep `status` from refreshing index stat info
 * into an index rewrite, and `core.fsmonitor=false` keeps a configured
 * fsmonitor hook out of every call. `GIT_TERMINAL_PROMPT=0`, closed
 * stdin and a timeout make a fetch that needs credentials fail instead
 * of waiting. Same runner contract as `lib/git.ts`: `git -C <root>`,
 * text output, exit status.
 */
export function runPlanGit(root: string, args: string[]): GitResult {
  const result = spawnSync(
    'git',
    [
      '--no-optional-locks',
      '-c', 'core.fsmonitor=false',
      '-c', 'gc.auto=0',
      '-c', 'maintenance.auto=false',
      '-C', root,
      ...args,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ETIMEDOUT' || code === 'ENOBUFS') {
    // A timed-out or runaway call failed, whatever its exit status.
    return {
      status: -1,
      stdout: '',
      stderr: code === 'ETIMEDOUT'
        ? `git timed out after ${GIT_TIMEOUT_MS / 1000}s`
        : 'git output exceeded the planner limit',
    };
  }
  if (result.error) throw result.error;
  let status = result.status;
  if (status === null) {
    const signals = osConstants.signals as Record<string, number>;
    status = -(signals[result.signal ?? ''] ?? 0) || -1;
  }
  return {
    status,
    stdout: universalNewlines(result.stdout ?? ''),
    stderr: universalNewlines(result.stderr ?? ''),
  };
}

/**
 * The library URL the consumer recorded for the submodule at `rel`:
 * `submodule.<name>.url` in the consumer's config (`git submodule init`
 * stores it resolved), else an absolute `.gitmodules` URL. A relative
 * `.gitmodules` URL resolves against the consumer's remote, which the
 * plan does not guess: null, like a missing entry.
 */
function submoduleUrl(
  run: (root: string, args: string[]) => GitResult,
  resolvedProject: string,
  rel: string,
): string | null {
  const paths = run(resolvedProject, [
    'config', '-z', '-f', '.gitmodules', '--get-regexp',
    '^submodule\\..*\\.path$',
  ]);
  if (paths.status !== 0) return null;
  for (const record of paths.stdout.split('\0')) {
    const newline = record.indexOf('\n');
    if (newline < 0 || record.slice(newline + 1) !== rel) continue;
    const name = record.slice('submodule.'.length, newline - '.path'.length);
    const local = run(resolvedProject, [
      'config', '--get', `submodule.${name}.url`,
    ]);
    if (local.status === 0 && pyStrip(local.stdout)) {
      return pyStrip(local.stdout);
    }
    const shared = run(resolvedProject, [
      'config', '-f', '.gitmodules', '--get', `submodule.${name}.url`,
    ]);
    const url = pyStrip(shared.stdout);
    if (shared.status === 0 && url && !/^\.\.?\//.test(url)) return url;
  }
  return null;
}

/**
 * Fetch `target` from `url` into the library without prompting,
 * submodule recursion or ref updates: the target is a single source
 * ref (refspecs are refused before this), and an empty `--refmap`
 * keeps a configured remote mapping from moving local refs. Unless the
 * owner configured an SSH command, SSH runs in batch mode.
 */
function fetchTarget(
  run: (root: string, args: string[]) => GitResult,
  resolvedSource: string,
  url: string,
  target: string,
): GitResult {
  const ssh =
    process.env.GIT_SSH_COMMAND === undefined &&
    process.env.GIT_SSH === undefined &&
    run(resolvedSource, ['config', '--get', 'core.sshCommand']).status !== 0
      ? ['-c', 'core.sshCommand=ssh -o BatchMode=yes']
      : [];
  return run(resolvedSource, [
    ...ssh,
    'fetch', '--quiet', '--no-recurse-submodules', '--no-write-commit-graph',
    '--refmap=', '--end-of-options', url, target,
  ]);
}

// --- Python-semantics helpers mirrored from install.ts -------------------------

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `Path.is_dir()` — follows links, false on error. */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `PurePath.is_relative_to` — a lexical component-prefix check. */
function isRelativeTo(target: string, root: string): boolean {
  return (
    target === root ||
    target.startsWith(root.endsWith('/') ? root : `${root}/`)
  );
}

/** `root in target.parents` — a proper ancestor only. */
function inParents(target: string, root: string): boolean {
  return target !== root && isRelativeTo(target, root);
}

const PY_WS =
  '\t\n\v\f\r \x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004' +
  '\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
const PY_WS_RE = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

/** `str.strip()` over Python's whitespace set. */
function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && PY_WS.includes(text[start])) start += 1;
  while (end > start && PY_WS.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** `str.split()` — runs of Python whitespace, edges stripped. */
function pySplit(text: string): string[] {
  const stripped = pyStrip(text);
  if (stripped === '') return [];
  return stripped.split(PY_WS_RE);
}

/** `mapping[key]` without the KeyError — callers check `dictHas` first. */
function dictGet(mapping: unknown, key: string): unknown {
  return mapping instanceof Map
    ? mapping.get(key)
    : (mapping as Record<string, unknown>)[key];
}

// --- Plan document -------------------------------------------------------------

export interface PlanStop {
  code: string;
  message: string;
}

export interface PlanDecision {
  flag: string;
  applies: boolean | 'owner';
  reason: string;
}

export interface PlanFollowUp {
  commands: string[];
  when: string;
  reason: string;
}

export interface PlanEdit {
  path: string;
  change: string;
}

export interface PlanDocument {
  status: 'ready' | 'stop';
  stops: PlanStop[];
  owner_questions: PlanStop[];
  notes: string[];
  library: {
    path: string | null;
    index_pin: string | null;
    committed_pin: string | null;
    head: string | null;
    branch: string | null;
    dirty: boolean | null;
    state: string;
  };
  pins: {
    old: string | null;
    new: string | null;
    old_name: string | null;
    new_name: string | null;
  };
  t3: {
    /** The T3 readiness choice recorded in `.agent-workflows-t3.json`. */
    choice: 'enabled' | 'declined' | null;
  };
  install: {
    flags: string[];
    command: string;
    check_command: string;
    decisions: PlanDecision[];
    /** Content edits the planned install would write, for owner review. */
    edits: PlanEdit[];
  };
  follow_ups: PlanFollowUp[];
}

export interface PlanOptions {
  /** A reviewed revision to adopt; fetched unless it is a commit SHA
   * already present in the library. */
  target?: string | null;
  /** Test seam replacing `runPlanGit`, like `install`'s `runGitImpl`. */
  runGitImpl?: (root: string, args: string[]) => GitResult;
}

interface LibraryState {
  path: string | null;
  index_pin: string | null;
  committed_pin: string | null;
  head: string | null;
  branch: string | null;
  dirty: boolean | null;
  state: string;
}

/**
 * Classify the pinned library checkout — `consumer_pin`'s read-only half
 * returned as data: every refusal becomes a stop entry carrying the same
 * message, never a thrown error.
 */
/**
 * The consumer's committed gitlink for `rel` (`ls-tree -z HEAD`): null
 * when HEAD records none, undefined when the tree cannot be read (an
 * unborn HEAD, or a partial clone that could not fetch it).
 */
function committedGitlink(
  run: (root: string, args: string[]) => GitResult,
  resolvedProject: string,
  rel: string,
): string | null | undefined {
  if (
    run(resolvedProject, ['rev-parse', '--verify', '--quiet', 'HEAD'])
      .status !== 0
  ) {
    return null;
  }
  const committed = run(resolvedProject, ['ls-tree', '-z', 'HEAD', '--', rel]);
  if (committed.status !== 0) return undefined;
  for (const record of committed.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const fields = pySplit(tab < 0 ? record : record.slice(0, tab));
    const path = tab < 0 ? '' : record.slice(tab + 1);
    if (
      fields.length === 3 &&
      fields[0] === '160000' &&
      fields[1] === 'commit' &&
      path === rel
    ) {
      return fields[2];
    }
  }
  return null;
}

function classifyLibrary(
  resolvedSource: string,
  resolvedProject: string,
  run: (root: string, args: string[]) => GitResult,
  stops: PlanStop[],
): LibraryState {
  const info: LibraryState = {
    path: isRelativeTo(resolvedSource, resolvedProject)
      ? relative(resolvedProject, resolvedSource) || '.'
      : null,
    index_pin: null,
    committed_pin: null,
    head: null,
    branch: null,
    dirty: null,
    state: 'not-pinned',
  };
  const stop = (state: string, code: string, message: string): LibraryState => {
    info.state = state;
    stops.push({ code, message });
    return info;
  };
  if (
    resolvedSource === resolvedProject ||
    !inParents(resolvedSource, resolvedProject)
  ) {
    return stop(
      'not-pinned',
      'not-pinned',
      'update plan applies only to a library pinned as a submodule of' +
        ' the project; a self-install, standalone or copied library takes' +
        ' the setup route instead',
    );
  }
  const rel = info.path as string;
  let top: GitResult;
  try {
    top = run(resolvedProject, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return stop(
        'not-pinned',
        'not-pinned',
        'update plan applies only to a library pinned as a submodule;' +
          ' no Git is available to inspect the consumer',
      );
    }
    throw error;
  }
  if (top.status) {
    return stop(
      'not-pinned',
      'not-pinned',
      'update plan applies only to a library pinned as a submodule;' +
        ' the project is not a Git worktree',
    );
  }
  if (pyResolve(pyStrip(top.stdout)) !== resolvedProject) {
    return stop(
      'not-pinned',
      'project-root',
      'Consumer --project must be the Git worktree root;' +
        ' rerun from the owning repository root',
    );
  }
  const listing = run(resolvedProject, ['ls-files', '-s', '-z', '--', rel]);
  if (listing.status) {
    return stop(
      'index-conflict',
      'index-conflict',
      `Could not read the consumer's index for ${rel};` +
        ' preserve and review',
    );
  }
  const matches: string[][] = [];
  for (const record of listing.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const entry = tab < 0 ? record : record.slice(0, tab);
    const path = tab < 0 ? '' : record.slice(tab + 1);
    if (path === rel) matches.push(pySplit(entry));
  }
  if (!matches.length) {
    return stop(
      'not-pinned',
      'not-pinned',
      `Library ${rel} is not a registered submodule pin; update` +
        ' applies only to a submodule pin — use the setup route for a' +
        ' copied or standalone library',
    );
  }
  if (
    matches.length !== 1 ||
    matches[0].length !== 3 ||
    matches[0][0] !== '160000' ||
    matches[0][2] !== '0'
  ) {
    return stop(
      'index-conflict',
      'index-conflict',
      `Unresolved library pin for ${rel}; the consumer's index` +
        ' entry is missing, duplicated or conflicted; review the' +
        ' declared submodule pin',
    );
  }
  info.index_pin = matches[0][1];

  const runLib = (...args: string[]) => run(resolvedSource, args);

  if (!existsSync(join(resolvedSource, '.git'))) {
    return stop(
      'uninitialized',
      'uninitialized',
      `Pinned library ${rel} is registered but uninitialized;` +
        ' initialize it with `git submodule update --init --' +
        ` ${shlexQuote(rel)}\``,
    );
  }
  const probe = runLib('rev-parse', '--show-toplevel');
  if (probe.status || pyResolve(pyStrip(probe.stdout)) !== resolvedSource) {
    return stop(
      'unreadable',
      'unreadable',
      `Pinned library ${rel} is not a readable Git checkout;` +
        ' preserve and review',
    );
  }
  // The plan does not inspect nested checkouts: read the index for
  // gitlinks — a pure index read — and refuse nested submodules
  // outright; `--ignore-submodules=all` keeps status out of them.
  const index = runLib('ls-files', '-s', '-z');
  if (index.status) {
    return stop(
      'unreadable',
      'unreadable',
      `Could not inspect pinned library ${rel} index;` +
        ' preserve and repair the Git checkout',
    );
  }
  const gitlinks: string[] = [];
  for (const record of index.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const entry = tab < 0 ? record : record.slice(0, tab);
    const path = tab < 0 ? '' : record.slice(tab + 1);
    if (path && pySplit(entry)[0] === '160000') gitlinks.push(path);
  }
  if (gitlinks.length) {
    return stop(
      'nested-submodules',
      'nested-submodules',
      `Pinned library ${rel} registers nested submodule(s)` +
        ` ${gitlinks.join(', ')}; the plan does not inspect nested` +
        ' checkouts — inspect their state yourself (' +
        gitlinks
          .map((path) => `\`git -C ${shlexQuote(join(rel, path))} status\``)
          .join(', ') +
        ') before installation',
    );
  }
  // `status` runs the filter drivers the owner configured (Git LFS,
  // for example) exactly as their own `git status` does; a repository
  // cannot ship a driver command, only name one, and `core.fsmonitor`
  // is disabled in runPlanGit.
  const status = runLib(
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--ignore-submodules=all',
  );
  if (status.status) {
    return stop(
      'unreadable',
      'unreadable',
      `Could not inspect pinned library ${rel} status;` +
        ' preserve and repair the Git checkout',
    );
  }
  info.dirty = pyStrip(status.stdout) !== '';
  const headResult = runLib('rev-parse', '--verify', 'HEAD');
  if (headResult.status) {
    return stop(
      'unreadable',
      'unreadable',
      `Could not inspect pinned library ${rel} HEAD;` +
        ' preserve and repair the Git checkout',
    );
  }
  info.head = pyStrip(headResult.stdout);
  const ref = runLib('symbolic-ref', '-q', 'HEAD');
  if (ref.status !== 0 && ref.status !== 1) {
    return stop(
      'unreadable',
      'unreadable',
      `Could not inspect pinned library ${rel} branch;` +
        ' preserve and repair the Git checkout',
    );
  }
  const refOut = pyStrip(ref.stdout);
  info.branch = ref.status === 0
    ? (refOut.startsWith('refs/heads/') ? refOut.slice(11) : refOut)
    : null;
  const committedPin = committedGitlink(run, resolvedProject, rel);
  if (committedPin === undefined) {
    return stop(
      'unreadable',
      'unreadable',
      `Could not read the consumer's committed pin for ${rel};` +
        ' preserve and repair the consumer checkout',
    );
  }
  info.committed_pin = committedPin;
  if (info.dirty) {
    return stop(
      'dirty',
      'dirty',
      `Pinned library ${rel} is dirty; preserve and review local` +
        ' changes before installation',
    );
  }
  if (info.head !== info.index_pin) {
    if (runLib('merge-base', '--is-ancestor', info.index_pin, info.head).status === 0) {
      return stop(
        'ahead',
        'ahead',
        `Pinned library ${rel} is ahead of the recorded pin` +
          ` ${info.index_pin}; stage a reviewed pin adoption` +
          ` (\`git add ${shlexQuote(rel)}\`) or preserve the local commits` +
          ' (for example push them or record them on a branch) and' +
          ' restore the recorded pin before installation',
      );
    }
    return stop(
      'diverged',
      'diverged',
      `Pinned library ${rel} is at ${info.head}, which differs from the` +
        ` consumer's recorded pin ${info.index_pin}; stage the reviewed pin` +
        ` (\`git add ${shlexQuote(rel)}\`) or restore the recorded pin` +
        ` (\`git submodule update -- ${shlexQuote(rel)}\`)`,
    );
  }
  info.state =
    info.committed_pin === info.index_pin ? 'at-pin' : 'adoption-staged';
  return info;
}

/** `git describe --tags --always <sha>` in the library, or null. */
function describeName(
  run: (root: string, args: string[]) => GitResult,
  resolvedSource: string,
  sha: string | null,
): string | null {
  if (sha === null) return null;
  const result = run(resolvedSource, ['describe', '--tags', '--always', sha]);
  return result.status === 0 ? pyStrip(result.stdout) : null;
}

/**
 * `.toml` basenames under `.codex/agents/` at a library commit, via
 * ls-tree. `null` means the tree itself is unreadable — a missing
 * object the plan reports as objects-unavailable. A `null`
 * sha (no pin recorded) is an empty set, not a failure.
 */
function treeProfiles(
  run: (root: string, args: string[]) => GitResult,
  resolvedSource: string,
  sha: string | null,
): Set<string> | null {
  const names = new Set<string>();
  if (sha === null) return names;
  const listing = run(resolvedSource, [
    'ls-tree', '-z', '--name-only', sha, '.codex/agents/',
  ]);
  if (listing.status !== 0) return null;
  for (const record of listing.stdout.split('\0')) {
    if (!record) continue;
    const name = basename(record);
    if (name.endsWith('.toml')) names.add(name);
  }
  return names;
}

/**
 * Whether `path` exists in `sha`'s tree. `ls-tree` keeps an unreadable
 * tree — a missing partial-clone object — an error to report (never a
 * fetch) while an absent path stays a plain `false`.
 */
function treeEntry(
  run: (root: string, args: string[]) => GitResult,
  resolvedSource: string,
  sha: string,
  path: string,
): boolean | null {
  const result = run(resolvedSource, ['ls-tree', '-z', sha, '--', path]);
  if (result.status !== 0) return null;
  return pyStrip(result.stdout) !== '';
}

/**
 * Target-tracked paths that are untracked at HEAD and present in the
 * library worktree — the ignored owner files `checkout
 * --no-overwrite-ignore` would preserve by refusing. `null` means a
 * tree is missing from a partial clone — callers report it with
 * `missingObjectsStop`; an lstat-missing path is simply no collision.
 */
function ignoredCollisions(
  run: (root: string, args: string[]) => GitResult,
  resolvedSource: string,
  sha: string,
): string[] | null {
  const headListing = run(resolvedSource, [
    'ls-tree', '-r', '-z', '--name-only', 'HEAD',
  ]);
  if (headListing.status !== 0) return null;
  const tracked = new Set(headListing.stdout.split('\0'));
  const targetListing = run(resolvedSource, [
    'ls-tree', '-r', '-z', '--name-only', sha,
  ]);
  if (targetListing.status !== 0) return null;
  const collisions: string[] = [];
  for (const record of targetListing.stdout.split('\0')) {
    if (!record || tracked.has(record)) continue;
    try {
      lstatSync(join(resolvedSource, record));
      collisions.push(record);
    } catch {
      // Absent from the worktree — nothing the checkout could refuse.
    }
  }
  return collisions.sort(compareCodePoints);
}

/**
 * Whether a library commit ships `update plan` — the planner script and
 * the dispatcher's update registration both. `null` means a tree or
 * blob is missing from a partial clone — callers report it with
 * `missingObjectsStop`.
 */
function treeCarriesUpdatePlan(
  run: (root: string, args: string[]) => GitResult,
  resolvedSource: string,
  sha: string,
): boolean | null {
  const script = treeEntry(
    run,
    resolvedSource,
    sha,
    'scripts/update_plan.ts',
  );
  if (script === null) return null;
  if (!script) return false;
  const entry = run(resolvedSource, [
    'ls-tree', '-z', sha, '--', 'bin/agent-workflows.ts',
  ]);
  if (entry.status !== 0) return null;
  const tab = entry.stdout.indexOf('\t');
  const fields = tab < 0 ? [] : pySplit(entry.stdout.slice(0, tab));
  if (fields.length !== 3 || fields[1] !== 'blob') return false;
  const blob = run(resolvedSource, ['cat-file', 'blob', fields[2]]);
  if (blob.status !== 0) return null;
  return blob.stdout.includes('update_plan');
}

/**
 * The toolkit a library commit ships — `toolkit()`'s contract read from
 * objects, not the worktree: the `.agents/skills/<name>/SKILL.md` set
 * classified installed vs reference-only by frontmatter, minus memory
 * skills (the routine refresh never installs them) and the names a
 * third-party installer recorded in the root lock file. `null` means a
 * tree or blob is missing from a partial clone — callers report it with
 * `missingObjectsStop`; a malformed lock raises the same ValueError the
 * filesystem path does.
 */
interface TreeToolkit {
  names: [installed: string[], referenceOnly: string[]];
  thirdParty: Set<string>;
}

function treeToolkit(
  run: (root: string, args: string[]) => GitResult,
  resolvedSource: string,
  sha: string,
): TreeToolkit | null {
  const lockEntry = run(resolvedSource, [
    'ls-tree',
    '-z',
    sha,
    '--',
    SKILLS_LOCK,
  ]);
  if (lockEntry.status !== 0) return null;
  const lockTab = lockEntry.stdout.indexOf('\t');
  const lockFields =
    lockTab < 0 ? [] : pySplit(lockEntry.stdout.slice(0, lockTab));
  const thirdParty = new Set<string>();
  if (lockFields.length === 3 && lockFields[1] === 'blob') {
    const blob = run(resolvedSource, ['cat-file', 'blob', lockFields[2]]);
    if (blob.status !== 0) return null;
    for (const name of third_party_skills_text(
      blob.stdout,
      `${SKILLS_LOCK} in ${sha}`,
    )) {
      thirdParty.add(name);
    }
  }
  const listing = run(resolvedSource, [
    'ls-tree',
    '-z',
    '-r',
    sha,
    '--',
    '.agents/skills',
  ]);
  if (listing.status !== 0) return null;
  const prefix = '.agents/skills/';
  const suffix = '/SKILL.md';
  const documents = new Map<string, string>();
  for (const record of listing.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const meta = tab < 0 ? record : record.slice(0, tab);
    const path = tab < 0 ? '' : record.slice(tab + 1);
    const fields = pySplit(meta);
    if (fields.length !== 3 || fields[1] !== 'blob') continue;
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) continue;
    const name = path.slice(prefix.length, -suffix.length);
    if (name === '' || name.includes('/')) continue;
    documents.set(name, fields[2]);
  }
  const installed: string[] = [];
  const referenceOnly: string[] = [];
  for (const name of [...documents.keys()].sort(compareCodePoints)) {
    if (MEMORY_SKILLS.includes(name) || thirdParty.has(name)) continue;
    const blob = run(resolvedSource, [
      'cat-file',
      'blob',
      documents.get(name) as string,
    ]);
    if (blob.status !== 0) return null;
    if (is_reference_only_text(blob.stdout)) referenceOnly.push(name);
    else installed.push(name);
  }
  return { names: [installed, referenceOnly], thirdParty };
}

/**
 * Consumer `.codex/agents/<name>.toml` links resolving to the managed
 * same-name library target — the only links `--codex-agents` itself
 * would create. Links resolving into the library under another name
 * count for neither completeness nor a clean pass; they are conflicts
 * the installer refuses, returned separately for the plan's notes.
 */
function linkedProfiles(
  resolvedSource: string,
  resolvedProject: string,
): [Set<string>, Array<[string, string]>] {
  const linked = new Set<string>();
  const conflicts: Array<[string, string]> = [];
  const agentsDir = join(resolvedProject, '.codex/agents');
  const libraryAgents = join(resolvedSource, '.codex/agents');
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [linked, conflicts];
  }
  for (const entry of entries) {
    const path = join(agentsDir, entry);
    if (!isSymlink(path)) continue;
    let resolved: string;
    try {
      resolved = pyResolve(path);
    } catch {
      // A link loop is neither a managed link nor a named conflict.
      continue;
    }
    if (resolved === join(libraryAgents, entry)) {
      linked.add(entry);
    } else if (inParents(resolved, libraryAgents)) {
      conflicts.push([entry, resolved]);
    }
  }
  return [linked, conflicts];
}

/**
 * Whether `.claude/skills` holds a symlink `--claude-skills` itself
 * would create: resolving to the toolkit skill's library path
 * (`join(skill_root, name)`). A link to a consumer-owned skill — or
 * into the library under another or a non-toolkit name — is no mirror
 * of the toolkit.
 */
function claudeMirrored(
  resolvedSource: string,
  resolvedProject: string,
  installed: Set<string>,
): boolean {
  const claudeRoot = join(resolvedProject, CLAUDE_SKILLS);
  const skillRoot = join(resolvedSource, '.agents/skills');
  let entries: string[];
  try {
    entries = readdirSync(claudeRoot);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!installed.has(entry)) continue;
    const path = join(claudeRoot, entry);
    if (!isSymlink(path)) continue;
    try {
      if (pyResolve(path) === join(skillRoot, entry)) return true;
    } catch {
      // A link loop is no managed mirror.
    }
  }
  return false;
}

/**
 * The error classes a read-only inspection legitimately raises —
 * ValueError-class refusals, UnicodeDecodeError, RuntimeError (a symlink
 * loop) and the OSError family, including raw Node errno errors.
 * Anything else is a genuine bug and keeps the exit-1 path.
 */
const INSPECTION_ERROR_NAMES = new Set([
  'ValueError',
  'UnicodeDecodeError',
  'RuntimeError',
  'OSError',
  'FileNotFoundError',
  'NotADirectoryError',
  'IsADirectoryError',
  'FileExistsError',
  'PermissionError',
]);

function isInspectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name =
    (error as NodeJS.ErrnoException).code !== undefined
      ? osErrorName(error)
      : error.name;
  return INSPECTION_ERROR_NAMES.has(name);
}

/**
 * Build the update plan for `project` against the pinned library at
 * `source`. Read-only: filesystem reads and `git` read commands only.
 * An inspection failure (ValueError/OSError-class) becomes a normal
 * `stop` plan — printed and exit 3 — never exit 1 with empty stdout;
 * anything else is a bug and propagates.
 */
export function plan(
  source: string,
  project: string,
  options: PlanOptions = {},
): PlanDocument {
  try {
    return buildPlan(source, project, options);
  } catch (error) {
    if (!isInspectionError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    let path: string | null = null;
    try {
      const resolvedSource = pyResolve(source);
      const resolvedProject = pyResolve(project);
      if (
        resolvedSource !== resolvedProject &&
        inParents(resolvedSource, resolvedProject)
      ) {
        path = relative(resolvedProject, resolvedSource);
      }
    } catch {
      // Keep the fallback document minimal.
    }
    return {
      status: 'stop',
      stops: [
        {
          code: 'inspection-error',
          message:
            'Could not complete the read-only inspection' +
            (path === null ? '' : ` of pinned library ${path}`) +
            `: ${message}`,
        },
      ],
      owner_questions: [],
      notes: [],
      library: {
        path,
        index_pin: null,
        committed_pin: null,
        head: null,
        branch: null,
        dirty: null,
        state: 'inspection-error',
      },
      pins: { old: null, new: null, old_name: null, new_name: null },
      t3: { choice: null },
      install: {
        flags: [],
        command: '',
        check_command: '',
        decisions: [],
        edits: [],
      },
      follow_ups: [],
    };
  }
}

/**
 * The document state one phase hands the next: the document fields the
 * phases build — stops, owner questions, notes, edits, follow-ups —
 * plus the intermediate facts (pins, recorded choices, destination
 * tree, flag applications) later phases consume.
 */
interface PlanState {
  /** Resolved pinned-library path. */
  source: string;
  /** Resolved consumer root. */
  project: string;
  run: (root: string, args: string[]) => GitResult;
  target: string | null;
  stops: PlanStop[];
  ownerQuestions: PlanStop[];
  notes: string[];
  followUps: PlanFollowUp[];
  edits: PlanEdit[];
  library: LibraryState;
  agentsText: string | null;
  newPin: string | null;
  oldPin: string | null;
  pins: PlanDocument['pins'];
  memoryChoice: string | null;
  t3Choice: 'enabled' | 'declined' | null;
  t3Enabled: boolean;
  decisions: PlanDecision[];
  flags: string[];
  linked: Set<string>;
  codexConflicts: Array<[string, string]>;
  codexWanted: Set<string> | null;
  codexManaged: boolean;
  destinationSha: string | null;
  destinationToolkit: TreeToolkit | null;
  claude: boolean;
  /** The `--claude-skills` owner question — kept so the conditional
   * mirror preflight can attach its outcome. */
  claudeQuestion: PlanStop | null;
  cutover: PlanFollowUp | null;
  command: string;
  checkCommand: string;
}

function missingObjectsStop(state: PlanState, sha: string | null): void {
  state.stops.push({
    code: 'objects-unavailable',
    message:
      `Cannot read the tree of ${sha} in the pinned library` +
      ` ${state.library.path}; the checkout is missing objects and` +
      ' could not fetch them — fetch the target into the library and' +
      ' rerun',
  });
}

function helperCommand(
  state: PlanState,
  script: string,
  args: string[],
): string {
  return repair_command(state.source, state.project, script, args);
}

/**
 * Pin and library phase: classify the checkout, read the consumer
 * contract, and resolve (fetching when needed) the adoption target and
 * pins.
 */
function phasePinAndLibrary(state: PlanState): void {
  const { run } = state;
  const resolvedSource = state.source;
  const resolvedProject = state.project;
  const library = classifyLibrary(
    resolvedSource,
    resolvedProject,
    run,
    state.stops,
  );
  state.library = library;
  const rel = library.path;
  const agents = join(resolvedProject, 'AGENTS.md');
  if (isFile(agents)) {
    state.agentsText = readText(agents);
  } else {
    state.stops.push({
      code: 'missing-contract',
      message: `Missing consumer contract: ${agents}`,
    });
  }

  // -- Target resolution and pins ------------------------------------------------

  if (
    state.target !== null &&
    (library.state === 'at-pin' || library.state === 'adoption-staged')
  ) {
    // A full commit SHA already present needs no fetch; anything else —
    // a branch, a tag, an abbreviated or missing SHA — is fetched from
    // the consumer's recorded library URL and resolved from FETCH_HEAD,
    // so `main` means the remote's branch, never a stale local one.
    // Refspec syntax would let the fetch write refs, so it is refused.
    const target = state.target;
    const fail = (message: string) => {
      state.stops.push({ code: 'target-unavailable', message });
    };
    let targetSha: string | null = null;
    const local = run(resolvedSource, [
      'rev-parse', '--verify', '--quiet', '--end-of-options',
      `${target}^{commit}`,
    ]);
    if (/[:*]/.test(target) || target.startsWith('+') || target.startsWith('-')) {
      fail(
        `Target ${pyRepr(target)} is not a revision name; pass a commit` +
          ' SHA, a tag or a branch',
      );
    } else if (
      local.status === 0 &&
      /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(target.toLowerCase())
    ) {
      targetSha = pyStrip(local.stdout);
    } else {
      const url = submoduleUrl(run, resolvedProject, rel as string);
      const fetched = url === null
        ? null
        : fetchTarget(run, resolvedSource, url, target);
      // An abbreviated SHA cannot be fetched by name; one the library
      // already holds, and that the lookup resolved to itself rather
      // than to a same-named branch, is used as is.
      const localSha = pyStrip(local.stdout);
      const abbreviated =
        local.status === 0 &&
        /^[0-9a-f]{7,63}$/.test(target.toLowerCase()) &&
        localSha.startsWith(target.toLowerCase());
      if (fetched !== null && fetched.status === 0) {
        state.notes.push(
          `Fetched target ${pyRepr(target)} from ${url};` +
            ' confirm this is the reviewed library source',
        );
        const head = run(resolvedSource, [
          'rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}',
        ]);
        if (head.status === 0) {
          targetSha = pyStrip(head.stdout);
        } else {
          fail(
            `Target ${pyRepr(target)} fetched from ${url} does not name a` +
              ' commit',
          );
        }
      } else if (abbreviated) {
        targetSha = localSha;
        state.notes.push(
          `Target ${pyRepr(target)} resolved to ${localSha} already in` +
            ' the pinned library',
        );
      } else if (fetched === null) {
        fail(
          `Target ${pyRepr(target)} is not a commit in the pinned library` +
            ` ${rel}, and the consumer records no absolute submodule URL` +
            ' to fetch it from (a relative `.gitmodules` URL needs' +
            ' `git submodule init` first)',
        );
      } else {
        const reason = pyStrip(fetched.stderr).split('\n').pop() ||
          `git fetch exited ${fetched.status}`;
        fail(
          `Could not fetch target ${pyRepr(target)} from ${url} into the` +
            ` pinned library ${rel}: ${reason}`,
        );
      }
    }
    const resolved: GitResult = targetSha === null
      ? { status: -1, stdout: '', stderr: '' }
      : { status: 0, stdout: targetSha, stderr: '' };
    if (resolved.status === -1) {
      // The failure is already reported.
    } else if (
      run(resolvedSource, [
        'cat-file',
        '-e',
        `${pyStrip(resolved.stdout)}^{tree}`,
      ]).status !== 0
    ) {
      missingObjectsStop(state, pyStrip(resolved.stdout));
    } else {
      const targetSha = pyStrip(resolved.stdout);
      if (
        library.state === 'adoption-staged' &&
        targetSha !== library.index_pin
      ) {
        state.stops.push({
          code: 'target-mismatch',
          message:
            `Target ${targetSha} differs from the staged adoption` +
            ` ${library.index_pin}; the staged pin already records` +
            ' reviewed intent — review which pin applies before updating',
        });
      } else if (library.state === 'at-pin' && targetSha === library.index_pin) {
        state.notes.push(
          `Target ${pyRepr(state.target)} resolves to the recorded pin` +
            ` ${targetSha}; nothing to adopt`,
        );
      } else if (library.state === 'at-pin') {
        state.newPin = targetSha;
        // --no-overwrite-ignore keeps an ignored worktree file the
        // target newly tracks from a silent overwrite: the checkout
        // refuses instead. Detect the same set read-only — a path the
        // target tracks, untracked at HEAD, present in the worktree —
        // and name the files the owner preserves or moves first.
        const collisions = ignoredCollisions(
          run,
          resolvedSource,
          targetSha,
        );
        if (collisions === null) {
          missingObjectsStop(state, targetSha);
        } else if (collisions.length) {
          state.stops.push({
            code: 'ignored-collision',
            message:
              `Ignored-file collision adopting ${targetSha}: the target` +
              ` tracks ${collisions.join(', ')} while the library` +
              ' worktree holds ignored owner files at those paths; the' +
              ' checkout would refuse — preserve or move these owner' +
              ' files first',
          });
        }
        state.followUps.push({
          commands: [
            `git -C ${shlexQuote(rel as string)} checkout` +
              ` --no-overwrite-ignore --detach ${targetSha}`,
            `git add ${shlexQuote(rel as string)}`,
          ],
          when: 'before the install refresh',
          reason:
            `adopt the reviewed target ${targetSha}; staging the pin` +
            ' records reviewed intent while committing stays the' +
            " owner's decision",
        });
        const planner = treeCarriesUpdatePlan(
          run,
          resolvedSource,
          targetSha,
        );
        if (planner === null) {
          missingObjectsStop(state, targetSha);
        } else if (planner) {
          state.notes.push(
            'After adopting the target, rerun `update plan` from the' +
              " adopted dispatcher because the destination revision's" +
              ' rules apply',
          );
        } else {
          state.notes.push(
            `Target ${targetSha} predates \`update plan\`; after` +
              " adoption follow the target's own update-agent-workflows" +
              ` procedure (\`git -C ${shlexQuote(rel as string)} show` +
              ` ${targetSha}:.agents/skills/update-agent-workflows/` +
              'SKILL.md`); the install command shown is the current' +
              " revision's view",
          );
        }
      }
    }
  }
  if (library.state === 'adoption-staged' && state.newPin === null) {
    state.newPin = library.index_pin;
    state.notes.push(
      `A reviewed pin adoption is already staged: ${rel} records` +
        ` ${library.index_pin} over committed ${library.committed_pin ?? 'none'};` +
        " committing the pin bump stays the owner's decision",
    );
  }
  if (library.branch !== null) {
    state.notes.push(
      `Pinned library ${rel} is attached to branch` +
        ` ${pyRepr(library.branch)} at the recorded pin; the installer` +
        ' detaches in place at the same commit and the branch is' +
        ' preserved',
    );
  }

  state.oldPin =
    library.committed_pin ?? library.index_pin ?? library.head;
  state.pins = {
    old: state.oldPin,
    new: state.newPin,
    old_name: describeName(run, resolvedSource, state.oldPin),
    new_name: describeName(run, resolvedSource, state.newPin),
  };
}

/** Recorded capability choices: Basic Memory and T3. */
function phaseCapabilities(state: PlanState): void {
  try {
    state.memoryChoice = read_capabilities(state.project);
  } catch (error) {
    state.stops.push({
      code: 'capabilities',
      message: (error as Error).message,
    });
  }
  const t3Path = join(state.project, T3_CONFIG);
  if (isFile(t3Path)) {
    try {
      const data = validateT3Config(pyJsonLoads(readText(t3Path)));
      state.t3Choice = dictGet(data, 'choice') as 'enabled' | 'declined';
    } catch (error) {
      state.stops.push({
        code: 't3-config',
        message: (error as Error).message,
      });
    }
  }
  state.t3Enabled = state.t3Choice === 'enabled';
}

/**
 * Toolkit phase: which destinations the planned install manages, derived
 * from the tree the library checkout will carry — the adopted target or
 * recorded pin. A pre-adoption --target differs from the worktree HEAD,
 * so its installed/reference-only/third-party sets come from that
 * commit's objects; otherwise the worktree is the tree and the
 * filesystem toolkit applies.
 */
function phaseToolkit(state: PlanState): void {
  const { run } = state;
  const resolvedSource = state.source;
  [state.linked, state.codexConflicts] = linkedProfiles(
    resolvedSource,
    state.project,
  );
  state.destinationSha = state.newPin ?? state.library.index_pin;
  if (state.destinationSha !== null && state.library.head !== null) {
    if (state.destinationSha === state.library.head) {
      // toolkit()/third_party_skills() refusals — a malformed
      // skills-lock.json is one — propagate to plan()'s
      // inspection-error stop rather than hiding behind an empty
      // managed set.
      state.destinationToolkit = {
        names: toolkit(resolvedSource),
        thirdParty: third_party_skills(resolvedSource),
      };
    } else {
      state.destinationToolkit = treeToolkit(
        run,
        resolvedSource,
        state.destinationSha,
      );
      if (state.destinationToolkit === null) {
        missingObjectsStop(state, state.destinationSha);
      }
    }
  }
}

/**
 * Policy phase: install's own AGENTS.md policy pipeline over the
 * consumer instructions, run without writing — a linked instruction
 * file, a malformed or customized legacy worktree block, a malformed or
 * customized collaboration block, or a reference-only pointer block
 * that no longer matches the destination toolkit's generated text are
 * the refusals install raises; the plan reports them as policy-review
 * stops carrying install's own messages. Missing blocks become an edit
 * the owner reviews, never a refusal.
 */
function phasePolicy(state: PlanState): void {
  const agents = join(state.project, 'AGENTS.md');
  if (state.agentsText !== null) {
    try {
      if (isSymlink(agents)) {
        throw new ValueError(
          `Linked consumer instructions; preserve and review: ${agents}`,
        );
      }
      const migrated = remove_legacy_worktree_block(
        state.agentsText,
        state.source,
        state.project,
        agents,
      );
      const managedBlocks: [string, string, string, string][] = [
        [COLLAB_START, COLLAB_END, 'collaboration policy', COLLAB_BLOCK],
      ];
      let updated = apply_policy_blocks(migrated, managedBlocks, agents);
      const referenceOnly =
        state.destinationToolkit === null
          ? []
          : state.destinationToolkit.names[1];
      if (referenceOnly.length) {
        const pointer: [string, string, string, string] = [
          REF_START,
          REF_END,
          'reference-only pointer',
          reference_block(
            state.source,
            state.project,
            [...referenceOnly].sort(compareCodePoints),
          ),
        ];
        updated = apply_policy_blocks(updated, [pointer], agents);
      }
      if (updated !== state.agentsText) {
        state.edits.push({
          path: 'AGENTS.md',
          change: 'update managed policy blocks',
        });
      }
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      state.stops.push({
        code: 'policy-review',
        message: (error as Error).message,
      });
    }
  }
}

/**
 * Install-flags phase: decide each flag from the recorded consumer
 * intent — the codex profile set the planned install would touch, the
 * Claude mirror, delivery profiles, and the never-routine `--memory`.
 */
function phaseInstallFlags(state: PlanState): void {
  const { run } = state;
  const resolvedSource = state.source;
  const resolvedProject = state.project;
  const library = state.library;

  // The profile set the planned install would touch: the tree the
  // library checkout will carry when install runs — the adopted target,
  // else the recorded pin.
  if (state.linked.size === 0) {
    state.decisions.push({
      flag: '--codex-agents',
      applies: false,
      reason: 'no consumer .codex/agents links resolve into the library',
    });
  } else {
    const wantedSha = state.newPin ?? library.index_pin;
    const wanted = treeProfiles(run, resolvedSource, wantedSha);
    state.codexWanted = wanted;
    const covers = (set: Set<string>) =>
      set.size > 0 && [...set].every((name) => state.linked.has(name));
    if (wanted === null) {
      missingObjectsStop(state, wantedSha);
    } else if (covers(wanted)) {
      state.flags.push('--codex-agents');
      state.decisions.push({
        flag: '--codex-agents',
        applies: true,
        reason:
          'consumer .codex/agents links cover the complete profile set;' +
          ' the flag installs every library profile',
      });
    } else {
      const oldSet = treeProfiles(run, resolvedSource, state.oldPin);
      if (oldSet === null) {
        missingObjectsStop(state, state.oldPin);
      } else if (covers(oldSet)) {
        state.flags.push('--codex-agents');
        state.decisions.push({
          flag: '--codex-agents',
          applies: true,
          reason:
            'consumer .codex/agents links cover the complete profile' +
            ' set the recorded pin added; the flag installs every' +
            ' library profile',
        });
      } else {
        state.decisions.push({
          flag: '--codex-agents',
          applies: false,
          reason:
            'consumer .codex/agents links are a partial profile' +
            ' selection; the flag would install every library profile',
        });
        state.notes.push('partial profile selection preserved');
      }
    }
  }
  // Conflicting codex links at destinations the planned install would
  // touch become link-conflict stops in the preflight below; every
  // other conflicting link stays a note.
  state.codexManaged =
    state.flags.includes('--codex-agents') && state.codexWanted !== null;
  for (const [name, linkTarget] of state.codexConflicts) {
    if (
      state.codexManaged &&
      (state.codexWanted as Set<string>).has(name)
    ) {
      continue;
    }
    state.notes.push(
      `conflicting .codex/agents link ${name} resolves to ${linkTarget}` +
        ' under a different name; the installer refuses managed links' +
        ' that resolve elsewhere — retarget it only after a reviewed' +
        ' decision',
    );
  }

  state.claude =
    state.destinationToolkit !== null &&
    claudeMirrored(
      resolvedSource,
      resolvedProject,
      new Set(state.destinationToolkit.names[0]),
    );
  if (state.claude) {
    state.flags.push('--claude-skills');
  }
  state.decisions.push({
    flag: '--claude-skills',
    applies: state.claude,
    reason: state.claude
      ? `${CLAUDE_SKILLS} already mirrors the toolkit`
      : 'no .claude/skills links resolve into the toolkit',
  });
  // install's root CLAUDE.md preflight is read-only — run it whether the
  // flag applies (its refusals become stops, a returned import edit is
  // recorded for the owner) or stays an owner question (the conditional
  // outcome is attached to it).
  let claudeImport: ClaudeImport | null = null;
  let claudeImportError: string | null = null;
  try {
    claudeImport = prepare_claude_import(resolvedProject);
  } catch (error) {
    claudeImportError =
      error instanceof Error ? error.message : String(error);
  }
  if (state.claude) {
    if (claudeImportError !== null) {
      state.stops.push({
        code: 'claude-instructions',
        message: claudeImportError,
      });
    } else if (claudeImport !== null && claudeImport[2] !== claudeImport[1]) {
      state.edits.push({
        path: relative(resolvedProject, claudeImport[0]),
        change: 'add @AGENTS.md import',
      });
    }
  } else {
    const question: PlanStop = {
      code: 'claude-skills',
      message:
        'pass --claude-skills only if the owner explicitly selects' +
        ' Claude',
    };
    if (claudeImportError !== null) {
      question.message +=
        `; selecting Claude would be refused:` +
        ` ${claudeImportError}; resolve first`;
    } else if (claudeImport !== null && claudeImport[2] !== claudeImport[1]) {
      question.message +=
        `; selecting Claude adds \`@AGENTS.md\` to` +
        ` ${relative(resolvedProject, claudeImport[0])}`;
    }
    state.ownerQuestions.push(question);
    state.claudeQuestion = question;
  }

  let deliveryPresent = false;
  try {
    // lstat: an existing entry — including a dangling symlink — is
    // consumer-owned and preserved, never a fresh offer.
    lstatSync(join(resolvedProject, DELIVERY_PROFILES));
    deliveryPresent = true;
  } catch {
    // absent — the owner is offered creation below
  }
  if (deliveryPresent) {
    state.decisions.push({
      flag: '--delivery-profiles',
      applies: false,
      reason:
        `${DELIVERY_PROFILES} is consumer-owned and preserved` +
        ' byte-for-byte',
    });
    state.notes.push('existing delivery profiles preserved byte-for-byte');
  } else {
    state.decisions.push({
      flag: '--delivery-profiles',
      applies: 'owner',
      reason:
        `${DELIVERY_PROFILES} is missing; on owner acceptance the flag` +
        ' creates it containing {}',
    });
    state.ownerQuestions.push({
      code: 'delivery-profiles',
      message:
        `offer the delivery-profiles option: on acceptance add` +
        ` --delivery-profiles, which creates ${DELIVERY_PROFILES}` +
        ' containing {}',
    });
  }

  if (state.memoryChoice === null) {
    if (!state.stops.some((entry) => entry.code === 'capabilities')) {
      state.ownerQuestions.push({
        code: 'memory-choice',
        message:
          `Basic Memory choice is not recorded in ${CAPABILITIES_FILE};` +
          ' recording one is setup or enablement, not an update failure',
      });
    }
  }
  state.decisions.push({
    flag: '--memory',
    applies: false,
    reason:
      'never passed in a routine refresh; ' +
      (state.memoryChoice === null
        ? 'no choice is recorded'
        : `recorded choice ${pyRepr(state.memoryChoice)}`),
  });
}

/**
 * The refusal text install's `link_status` classification would produce
 * for a managed destination, or null when the destination is fine.
 */
function managedLinkConflict(
  destination: string,
  target: string,
  allowLocal: boolean,
): string | null {
  let status: string;
  try {
    status = link_status(destination, target);
  } catch {
    // A symlink loop or otherwise unresolvable link cannot be the
    // expected target; the installer refuses it, so the plan stops.
    status = 'unresolvable';
  }
  if (status === 'unresolvable') {
    return (
      `Unresolvable symlink: ${destination}; the pinned toolkit` +
      ` expects ${target}; preserve and review`
    );
  }
  if (status === 'conflict') {
    let resolvedTo = '(unresolvable)';
    try {
      resolvedTo = pyResolve(destination);
    } catch {
      // Keep the parenthetical; the refusal stands either way.
    }
    return (
      `Conflicting symlink: ${destination} resolves to` +
      ` ${resolvedTo}; the pinned toolkit expects` +
      ` ${target}. Retarget it only after a reviewed decision`
    );
  }
  if (status === 'occupied' && !(allowLocal && isFile(destination))) {
    return (
      `Local skill conflict: ${destination}; a consumer file` +
      ' occupies the managed path the pinned toolkit expects to' +
      ` link to ${target}; choose one source explicitly`
    );
  }
  return null;
}

/**
 * Link-preflight phase: install.py's destination preflight, read-only.
 * Every managed destination the planned install would touch is
 * classified through the same `link_status`, and a destination install
 * would refuse — a symlink resolving elsewhere, a consumer file at a
 * managed path, or a link that cannot be resolved at all — stops the
 * plan instead of returning ready. Missing destinations are fine.
 * Retired entries are install's to retire, never a refusal, and
 * consumer-owned entries at unmanaged paths stay preserved. When
 * Claude stays an owner question the mirror checks still run — a
 * refusal attaches to the question instead of the stops.
 */
function phaseLinkPreflight(state: PlanState): void {
  const resolvedSource = state.source;
  const resolvedProject = state.project;
  const skillRoot = join(resolvedSource, '.agents/skills');
  const emitStop = (message: string): void => {
    state.stops.push({ code: 'link-conflict', message });
  };
  // A refusal the owner-selected flag would produce is attached to the
  // question — install's exact message, marked conditional.
  const emitClaude = (message: string): void => {
    if (state.claude) {
      emitStop(message);
    } else if (state.claudeQuestion !== null) {
      state.claudeQuestion.message +=
        `; selecting Claude would be refused: ${message};` +
        ' resolve first';
    }
  };
  const linkPlans: [Plan, (message: string) => void][] = [];
  if (state.destinationToolkit !== null) {
    for (const name of state.destinationToolkit.names[0]) {
      linkPlans.push([
        [
          join(resolvedProject, '.agents/skills', name),
          join(skillRoot, name),
          false,
        ],
        emitStop,
      ]);
    }
    for (const name of state.destinationToolkit.names[0]) {
      linkPlans.push([
        [
          join(resolvedProject, CLAUDE_SKILLS, name),
          join(skillRoot, name),
          false,
        ],
        emitClaude,
      ]);
    }
  }
  if (state.codexManaged) {
    for (const name of [...(state.codexWanted as Set<string>)].sort(
      compareCodePoints,
    )) {
      linkPlans.push([
        [
          join(resolvedProject, '.codex/agents', name),
          join(resolvedSource, '.codex/agents', name),
          true,
        ],
        emitStop,
      ]);
    }
  }
  for (const directory of [
    join(resolvedProject, '.claude'),
    join(resolvedProject, CLAUDE_SKILLS),
  ]) {
    if (
      (existsSync(directory) || isSymlink(directory)) &&
      !isDir(directory)
    ) {
      emitClaude(`Local skill conflict: ${directory}; preserve and review`);
    }
  }
  for (const [[destination, target, allowLocal], emit] of linkPlans) {
    const conflict = managedLinkConflict(destination, target, allowLocal);
    if (conflict !== null) emit(conflict);
  }
  if (state.destinationToolkit !== null) {
    const scanDirs: [string, (message: string) => void][] = [
      [join(resolvedProject, '.agents/skills'), emitStop],
      [join(resolvedProject, CLAUDE_SKILLS), emitClaude],
    ];
    for (const name of state.destinationToolkit.names[1]) {
      for (const [directory, emit] of scanDirs) {
        const link = join(directory, name);
        if (!isSymlink(link)) continue;
        let resolvedLink: string | null;
        try {
          resolvedLink = pyResolve(link);
        } catch {
          resolvedLink = null;
        }
        if (resolvedLink === null) {
          emit(`Unresolvable symlink: ${link}; preserve and review`);
        } else if (resolvedLink === join(skillRoot, name)) {
          emit(
            `Reference-only skill installed: ${link}; the pinned` +
              ` toolkit keeps ${name} in the library behind a managed` +
              ' pointer block in AGENTS.md; remove the link only after' +
              ' a reviewed decision',
          );
        }
      }
    }
    // install's report_unmanaged_links, read-only: a consumer link
    // resolving into the library at a name the planned toolkit does
    // not ship — dropped by an adopted target included — is an install
    // refusal, never free text. Retired names stay install's to
    // retire; memory-skill names belong to setup_memory's decision.
    const managedNames = new Set<string>([
      ...state.destinationToolkit.names[0],
      ...state.destinationToolkit.names[1],
      ...state.destinationToolkit.thirdParty,
    ]);
    if (state.memoryChoice === 'enabled') {
      for (const name of MEMORY_SKILLS) managedNames.add(name);
    }
    const retiredNames = new Set<string>([
      ...RETIRED_MEMORY_SKILLS,
      ...Object.keys(RETIRED_TOOLKIT_SKILLS),
    ]);
    for (const [directory, emit] of scanDirs) {
      let entries: string[];
      try {
        entries = readdirSync(directory);
      } catch {
        continue;
      }
      for (const entry of entries.sort(compareCodePoints)) {
        if (managedNames.has(entry)) continue;
        const link = join(directory, entry);
        if (!isSymlink(link)) continue;
        let resolvedLink: string | null;
        try {
          resolvedLink = pyResolve(link);
        } catch {
          resolvedLink = null;
        }
        // A retired name exempts only the link install itself retires —
        // a broken link resolving to the retired path inside the
        // library. A live link at a retired name faces the same review
        // as any other stale link.
        if (
          resolvedLink !== null &&
          retiredNames.has(entry) &&
          !existsSync(link) &&
          resolvedLink === join(skillRoot, entry)
        ) {
          continue;
        }
        if (resolvedLink === null) {
          emit(`Unresolvable symlink: ${link}; preserve and review`);
        } else if (inParents(resolvedLink, skillRoot)) {
          if (
            MEMORY_SKILLS.includes(entry) &&
            state.memoryChoice !== 'enabled'
          ) {
            emit(
              `Unexpected memory skill link: ${link} (resolves to` +
                ` ${resolvedLink}); no 'enabled' Basic Memory choice` +
                ` is recorded in ${CAPABILITIES_FILE}; remove the link` +
                ' only after a reviewed decision',
            );
          } else {
            emit(
              `Stale library skill link: ${link} (resolves to` +
                ` ${resolvedLink}); the planned toolkit does not` +
                ' include it; remove it only after a reviewed' +
                ' decision',
            );
          }
        }
      }
    }
  }
}

/**
 * T3 phase: the TypeScript cutover — an old pin shipping
 * scripts/t3_readiness.py moving to a dispatcher pin, a still-Python
 * action command, or the managed action still carrying the retired
 * identifier T3's 24-character script-ID limit rejects. Listed after
 * the memory refresh: t3_readiness needs the committed pin.
 */
function phaseT3(state: PlanState): void {
  const { run } = state;
  const resolvedSource = state.source;
  const resolvedProject = state.project;
  const library = state.library;
  if (!state.t3Enabled) return;
  const newTree = state.newPin ?? library.index_pin;
  const oldHas =
    state.oldPin === null
      ? false
      : treeEntry(
          run,
          resolvedSource,
          state.oldPin,
          'scripts/t3_readiness.py',
        );
  const newHas =
    newTree === null
      ? false
      : treeEntry(
          run,
          resolvedSource,
          newTree,
          'bin/agent-workflows.ts',
        );
  if (oldHas === null || newHas === null) {
    missingObjectsStop(state, oldHas === null ? state.oldPin : newTree);
  }
  const crosses = oldHas === true && newHas === true;
  let pythonAction = false;
  let legacyIdAction = false;
  const strayLaunchers: string[] = [];
  const t3Json = join(resolvedProject, 't3.json');
  if (isFile(t3Json)) {
    try {
      const data = pyJsonLoads(readText(t3Json));
      const scripts = dictGet(data, 'scripts');
      if (Array.isArray(scripts)) {
        for (const item of scripts) {
          if (python_era_action(item)) {
            pythonAction = true;
          } else if (legacy_id_action(item)) {
            legacyIdAction = true;
          } else if (
            typeof item === 'object' &&
            item !== null &&
            pyStrip(String(dictGet(item, 'command') ?? '')) ===
              `python3 ${T3_BOOTSTRAP}`
          ) {
            strayLaunchers.push(
              String(
                dictGet(item, 'id') ??
                  dictGet(item, 'name') ??
                  `python3 ${T3_BOOTSTRAP}`,
              ),
            );
          }
        }
      }
    } catch {
      // An unreadable t3.json is the readiness command's finding, not
      // the plan's; detection simply finds no Python action.
    }
  }
  if (strayLaunchers.length) {
    state.notes.push(
      `t3.json script(s) ${strayLaunchers.join(', ')} run the stale` +
        ` \`python3 ${T3_BOOTSTRAP}\` command outside the managed` +
        ' action; the cutover migrates only the managed action —' +
        ' review the extra launcher(s) separately',
    );
  }
  if (crosses || pythonAction || legacyIdAction) {
    state.cutover = {
      commands: [
        helperCommand(state, 't3_readiness.py', ['--check']),
        helperCommand(state, 't3_readiness.py', ['--configure-action']),
        helperCommand(state, 't3_readiness.py', ['--check']),
      ],
      when: 'after the owner commits the pin',
      reason:
        crosses || pythonAction
          ? 'the update crosses the TypeScript cutover; the generated T3' +
            ' action must migrate to the dispatcher bootstrap, and' +
            ' t3_readiness refuses until the committed pin matches; commit' +
            ' the regenerated action as the follow-up to the pin bump.' +
            ' The first --check is expected to fail with one of two' +
            ' diagnostics: the stale-launcher migration error' +
            ` (\`Generated bootstrap ${T3_BOOTSTRAP} needs migration to` +
            ` ${T3_BOOTSTRAP_MJS}\`) or a generated-asset diagnostic` +
            ' matching `Generated asset missing: <asset>; run' +
            ' --configure-action` (for example `t3.json` or' +
            ` \`${T3_BOOTSTRAP_MJS}\`); continue to --configure-action` +
            ' only on one of those diagnostics and report any other' +
            ' failure'
          : 'the managed T3 action still carries the retired id' +
            ' `agent-workflows-checkout-readiness`, which T3 rejects' +
            ' (script IDs are limited to 24 characters);' +
            ' --configure-action rewrites it to `agent-workflows-ready`' +
            ' in place, preserving a composed command and unrelated' +
            ' entries; commit the regenerated t3.json as the follow-up' +
            ' to the pin bump. The first --check is expected to fail' +
            ' with `Generated asset missing: t3.json; run' +
            ' --configure-action`; continue to --configure-action only' +
            ' on that diagnostic and report any other failure',
    };
    if (crosses || pythonAction) {
      state.notes.push(
        `the stale ${T3_BOOTSTRAP} is the owner's to remove — the` +
          ' library never deletes it',
      );
    }
    if (legacyIdAction) {
      state.notes.push(
        'import the action in T3 project settings (Actions -> Import' +
          ' scripts -> Import from t3.json) after the pin bump and' +
          ' regeneration unless the project already registered it: T3' +
          ' offers a t3.json entry only when no registered action shares' +
          ' its name or command, and a registered action keeps working' +
          ' with the new pin',
      );
      state.notes.push(
        'T3 assigns GUI-imported and hand-created actions an ID derived' +
          ' from the action name, so an effective action\'s ID can' +
          ' differ from the id in t3.json; that is expected, not drift',
      );
    }
  }
}

/**
 * Memory phase: the enabled Basic Memory capability, checked with
 * setup_memory's own rules. The plan surfaces the reviewed routing's
 * own state, then runs setup()'s complete read-only preflight — routing
 * parse, legacy capture hooks, customized instructions, memory policy,
 * machine profile, connection files and skill destinations — so every
 * refusal the scheduled helper would raise is a memory-review stop
 * carrying the helper's message and the follow-up is suppressed. An
 * absent machine profile stays an owner question, never a stop.
 */
function phaseMemory(state: PlanState): void {
  const { run } = state;
  const resolvedSource = state.source;
  const resolvedProject = state.project;
  const library = state.library;
  const rel = library.path;
  if (state.memoryChoice !== 'enabled') return;
  if (rel !== '.agent-workflows' || !isFile(join(resolvedProject, 'AGENTS.md'))) {
    state.stops.push({
      code: 'memory-path',
      message:
        'setup_memory requires the consumer root with AGENTS.md and' +
        ` its own .agent-workflows library path; this consumer's` +
        ` library is ${rel ?? resolvedSource}`,
    });
    return;
  }
  // The helper's reviewed input is the routing TOML; the generated
  // config.md is its product, classified the same way setup does.
  const routingInput = '.agents/memory/config.toml';
  let routingState = '';
  if (!isFile(join(resolvedProject, routingInput))) {
    state.stops.push({
      code: 'memory-routing-missing',
      message:
        `memory is enabled but ${routingInput} is missing; route` +
        ' through the setup-basic-memory skill with reviewed' +
        ' routing input — never invent routing',
    });
    return;
  }
  try {
    [, routingState] = expected_instructions(resolvedProject);
  } catch (error) {
    state.stops.push({
      code: 'memory-routing-invalid',
      message: (error as Error).message,
    });
    return;
  }
  if (routingState === 'customized') {
    state.stops.push({
      code: 'memory-instructions-customized',
      message:
        'Customized generated routing .agents/memory/config.md;' +
        ' preserve and review an explicit edit — setup_memory' +
        ' refuses to overwrite it',
    });
    return;
  }
  if (routingState === 'missing' || routingState === 'stale') {
    state.notes.push(
      `generated .agents/memory/config.md is ${routingState};` +
        ' setup_memory regenerates it from the reviewed routing',
    );
  }
  // setup_memory's own preflight over the same inputs, read-only: every
  // refusal the scheduled helper would raise before its first write —
  // routing, legacy hooks, customized instructions, memory policy, the
  // machine connection profile, connection files, skill destinations —
  // is a memory-review stop carrying the helper's exact message, and
  // the follow-up is suppressed. The destinations probe reads the
  // destination tree — adopted target or recorded pin — like the
  // managed-destination probes above.
  let memoryRefusal = false;
  let memoryTreeUnreadable = false;
  let memoryPre: ReturnType<typeof setup_preflight> | null = null;
  try {
    memoryPre = setup_preflight(resolvedSource, resolvedProject, {
      claude_skills: state.claude,
      library_has: (name) => {
        const skillPath = `.agents/skills/${name}/SKILL.md`;
        if (
          state.destinationSha === null ||
          state.destinationSha === state.library.head
        ) {
          return isFile(join(resolvedSource, skillPath));
        }
        const entry = treeEntry(
          run,
          resolvedSource,
          state.destinationSha,
          skillPath,
        );
        if (entry === null) {
          memoryTreeUnreadable = true;
          return true;
        }
        return entry;
      },
    });
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    memoryRefusal = true;
    state.stops.push({
      code: 'memory-review',
      message: (error as Error).message,
    });
  }
  if (memoryTreeUnreadable && state.destinationSha !== null) {
    missingObjectsStop(state, state.destinationSha);
  }
  // When Claude applies, setup_memory manages the same memory
  // destinations under .claude/skills through prepare_install — its
  // refusals stop the follow-up too. When Claude is still an owner
  // question, the same refusal is attached to the question instead.
  const emitMemoryClaude = (message: string): void => {
    if (state.claude) {
      memoryRefusal = true;
      state.stops.push({ code: 'memory-review', message });
    } else if (state.claudeQuestion !== null) {
      state.claudeQuestion.message +=
        `; selecting Claude would be refused: ${message};` +
        ' resolve first';
    }
  };
  if (
    !memoryRefusal &&
    memoryPre !== null &&
    memoryPre.missingProfileError === null &&
    (state.claude || state.claudeQuestion !== null)
  ) {
    for (const name of MEMORY_SKILLS) {
      const destination = join(resolvedProject, CLAUDE_SKILLS, name);
      const expected = join(resolvedSource, '.agents/skills', name);
      let status: string;
      try {
        status = link_status(destination, expected);
      } catch {
        status = 'unresolvable';
      }
      if (status === 'unresolvable') {
        emitMemoryClaude(
          `Unresolvable symlink: ${destination}; the pinned` +
              ` toolkit expects ${expected}; preserve and review`,
        );
      } else if (status === 'conflict') {
        let resolvedTo = '(unresolvable)';
        try {
          resolvedTo = pyResolve(destination);
        } catch {
          // Keep the parenthetical; the refusal stands.
        }
        emitMemoryClaude(
          `Conflicting symlink: ${destination} resolves to` +
              ` ${resolvedTo}; the pinned toolkit expects` +
              ` ${expected}. Retarget it only after a reviewed` +
              ' decision',
        );
      } else if (status === 'occupied') {
        emitMemoryClaude(
          `Local skill conflict: ${destination}; a consumer` +
              ' file occupies the managed path the pinned toolkit' +
              ` expects to link to ${expected}; choose one source` +
              ' explicitly',
        );
      }
    }
  }
  if (memoryRefusal || memoryPre === null) return;
  const memoryFlags: string[] = [];
  if (state.claude) memoryFlags.push('--claude-skills');
  // --share-config suppresses the .gitignore line setup_memory
  // would add: pass it only on established consumer intent —
  // anything under .agents/memory/ already tracked in the index.
  // Otherwise the missing ignore line is an owner question.
  const tracked = run(resolvedProject, [
    'ls-files',
    '-z',
    '--',
    '.agents/memory',
  ]);
  if (tracked.status === 0 && tracked.stdout !== '') {
    memoryFlags.push('--share-config');
  } else {
    const ignorePath = join(resolvedProject, '.gitignore');
    const ignore = isFile(ignorePath) ? readText(ignorePath) : '';
    if (!ignore.split(/\r\n|\r|\n/).includes('/.agents/memory/')) {
      state.ownerQuestions.push({
        code: 'memory-share-config',
        message:
          '`.gitignore` lacks `/.agents/memory/`: setup_memory' +
          ' will add it; pass --share-config to both' +
          ' setup_memory commands only if the consumer' +
          ' intentionally shares or leaves the directory' +
          ' unignored',
      });
    }
  }
  // A reviewed [connection] table opts into generated client
  // connection files: setup_memory needs the machine-local
  // profile, renders the ignored files for the selected clients,
  // and --check reports drift. Surface the opt-in's effects and
  // ask for the profile when it is absent — the update never
  // creates credentials.
  const clients = connectionClients(memoryPre.data) as string[];
  if (clients.length) {
    const profilePath = defaultProfilePath();
    state.notes.push(
      `reviewed routing opts into client connections for` +
        ` ${clients.join(', ')}; setup_memory requires the` +
        ` machine-local connection profile ${profilePath} to` +
        ' exist and be valid, renders the ignored client' +
        ' connection file(s) ' +
        clients
          .map((client) => CONNECTION_PATHS[client])
          .join(', ') +
        ', and --check reports connection drift for owner' +
        ' reconciliation',
    );
    if (memoryPre.missingProfileError !== null) {
      state.ownerQuestions.push({
        code: 'memory-connection-profile',
        message:
          `the machine connection profile ${profilePath} is` +
          ' absent; the update never creates credentials —' +
          ' create a reviewed profile holding the service' +
          ' endpoint and, when needed, the bearer-token' +
          ' environment-variable name (never the token value;' +
          ' see docs/memory/connections.md) before the' +
          ' setup_memory follow-up',
      });
    }
  }
  const setup = helperCommand(state, 'setup_memory.py', memoryFlags);
  state.followUps.push({
    commands: [setup, `${setup} --check`],
    when: 'after the install refresh',
    reason:
      'the recorded Basic Memory choice is enabled; refresh the' +
      ' memory capability set and routing',
  });
}

/** Follow-up phase: the install command and the ordered follow-ups. */
function phaseFollowUps(state: PlanState): void {
  state.command = repair_command(
    state.source,
    state.project,
    'install.py',
    state.flags,
  );
  state.checkCommand = `${state.command} --check`;

  if (state.cutover !== null) state.followUps.push(state.cutover);

  if (state.t3Enabled && state.memoryChoice === 'enabled') {
    state.followUps.push({
      commands: [
        helperCommand(state, 't3_readiness.py', ['--check-routing-source']),
      ],
      when: 'after the owner commits the pin',
      reason:
        'verify the tracked memory.routing_source matches the generated' +
        ' routing; it refuses until the committed pin matches',
    });
  }

  if (state.memoryChoice === 'enabled') {
    state.followUps.push({
      commands: [helperCommand(state, 'memory_preflight.py', [])],
      when: 'after the refresh',
      reason:
        'record the post-update memory state; --server-release is' +
        ' owner-supplied and never guessed',
    });
    state.notes.push(
      'memory_preflight: --server-release is owner-supplied and never' +
        ' guessed; a nonzero exit (3 incompatible, 4 unknown, 1 error)' +
        ' is a stop to report',
    );
  }
}

function buildPlan(
  source: string,
  project: string,
  options: PlanOptions = {},
): PlanDocument {
  const state: PlanState = {
    source: pyResolve(source),
    project: pyResolve(project),
    run: options.runGitImpl ?? runPlanGit,
    target: options.target ?? null,
    stops: [],
    ownerQuestions: [],
    notes: [],
    followUps: [],
    edits: [],
    library: {
      path: null,
      index_pin: null,
      committed_pin: null,
      head: null,
      branch: null,
      dirty: null,
      state: 'unreadable',
    },
    agentsText: null,
    newPin: null,
    oldPin: null,
    pins: { old: null, new: null, old_name: null, new_name: null },
    memoryChoice: null,
    t3Choice: null,
    t3Enabled: false,
    decisions: [],
    flags: [],
    linked: new Set<string>(),
    codexConflicts: [],
    codexWanted: null,
    codexManaged: false,
    destinationSha: null,
    destinationToolkit: null,
    claude: false,
    claudeQuestion: null,
    cutover: null,
    command: '',
    checkCommand: '',
  };
  phasePinAndLibrary(state);
  phaseCapabilities(state);
  phaseToolkit(state);
  phasePolicy(state);
  phaseInstallFlags(state);
  phaseLinkPreflight(state);
  phaseT3(state);
  phaseMemory(state);
  phaseFollowUps(state);
  return {
    status: state.stops.length === 0 ? 'ready' : 'stop',
    stops: state.stops,
    owner_questions: state.ownerQuestions,
    notes: state.notes,
    library: state.library,
    pins: state.pins,
    t3: { choice: state.t3Choice },
    install: {
      flags: state.flags,
      command: state.command,
      check_command: state.checkCommand,
      decisions: state.decisions,
      edits: state.edits,
    },
    follow_ups: state.followUps,
  };
}

// --- Rendering -------------------------------------------------------------------

/** Concise human-readable rendering of the same plan data. */
export function renderText(document: PlanDocument): string {
  const lines: string[] = [`status: ${document.status}`];
  for (const stop of document.stops) {
    lines.push(`stop [${stop.code}]: ${stop.message}`);
  }
  for (const question of document.owner_questions) {
    lines.push(`owner question [${question.code}]: ${question.message}`);
  }
  const library = document.library;
  lines.push(
    `library: ${library.path ?? '(none)'} — state ${library.state}`,
    `  index pin: ${library.index_pin ?? '(none)'}`,
    `  committed pin: ${library.committed_pin ?? '(none)'}`,
    `  head: ${library.head ?? '(none)'}` +
      `  branch: ${library.branch ?? '(none)'}` +
      `  dirty: ${
        library.dirty === null ? '(unknown)' : library.dirty ? 'yes' : 'no'
      }`,
  );
  const named = (sha: string | null, name: string | null) =>
    sha === null ? '(none)' : name === null ? sha : `${sha} (${name})`;
  lines.push(
    `pins: old ${named(document.pins.old, document.pins.old_name)}` +
      ` -> new ${named(document.pins.new, document.pins.new_name)}`,
    `t3: ${document.t3.choice ?? 'no recorded choice'}`,
  );
  lines.push(`install: ${document.install.command}`);
  lines.push(`check:   ${document.install.check_command}`);
  for (const decision of document.install.decisions) {
    const applies =
      decision.applies === 'owner'
        ? 'owner'
        : decision.applies
          ? 'pass'
          : 'skip';
    lines.push(`  ${decision.flag}: ${applies} — ${decision.reason}`);
  }
  for (const edit of document.install.edits) {
    lines.push(`edit: ${edit.path} — ${edit.change}`);
  }
  for (const followUp of document.follow_ups) {
    lines.push(`follow-up (${followUp.when}): ${followUp.reason}`);
    for (const command of followUp.commands) {
      lines.push(`  $ ${command}`);
    }
  }
  for (const note of document.notes) {
    lines.push(`note: ${note}`);
  }
  return `${lines.join('\n')}\n`;
}

// --- Command line -----------------------------------------------------------------

const PROG = 'agent-workflows.ts update';
const USAGE =
  `usage: ${PROG} plan [--project PROJECT] [--target REV] [--json]\n` +
  `       ${PROG} -h`;

const HELP_TEXT =
  `${USAGE}\n` +
  '\n' +
  'Plan a consumer pin refresh. The plan inspects the recorded pin, the\n' +
  'pinned library checkout, installed links and recorded capability choices,\n' +
  'then names the install flags and follow-up commands. It never writes,\n' +
  'stages or checks out; only --target fetches.\n' +
  '\n' +
  'subcommands:\n' +
  '  plan                  print the update plan\n' +
  '\n' +
  'options:\n' +
  '  -h, --help            show this help message and exit\n' +
  '  --project PROJECT     consumer root (default: .)\n' +
  '  --target REV          reviewed revision to adopt; a SHA already in\n' +
  '                        the library is used as is, anything else is\n' +
  '                        fetched from the recorded submodule URL\n' +
  '  --json                print the plan as one JSON document\n' +
  '\n' +
  'exit status: 0 plan ready (owner questions may remain), 3 stop for the\n' +
  'owner, 2 usage error, 1 unexpected error.\n';

function usageError(message: string): number {
  process.stderr.write(`${USAGE}\n${PROG}: error: ${message}\n`);
  return 2;
}

function libraryRoot(): string {
  return dirname(dirname(pyResolve(fileURLToPath(import.meta.url))));
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const [subcommand, ...rest] = argv;
  if (subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (subcommand === undefined) {
    return usageError('a subcommand is required (plan)');
  }
  if (subcommand !== 'plan') {
    return usageError(`unknown subcommand '${subcommand}'`);
  }
  let project = '.';
  let target: string | null = null;
  let json = false;
  const extras: string[] = [];
  let index = 0;
  while (index < rest.length) {
    const arg = rest[index];
    index += 1;
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(HELP_TEXT);
      return 0;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--project' || arg === '--target') {
      const value = index < rest.length ? rest[index] : undefined;
      // argparse refuses an option-like token as a value; a negative
      // number is not option-like when no option looks like one.
      if (
        value === undefined ||
        (value.length > 1 &&
          value.startsWith('-') &&
          !/^-\d+$|^-\d*\.\d+$/.test(value))
      ) {
        return usageError(`argument ${arg}: expected one argument`);
      }
      index += 1;
      if (arg === '--project') project = value;
      else target = value;
      continue;
    }
    if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
      continue;
    }
    if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
      continue;
    }
    extras.push(arg);
  }
  if (extras.length) {
    return usageError(`unrecognized arguments: ${extras.join(' ')}`);
  }
  let document: PlanDocument;
  try {
    document = plan(libraryRoot(), project, { target });
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  process.stdout.write(
    json ? `${jsonDumps(document)}\n` : renderText(document),
  );
  return document.status === 'stop' ? 3 : 0;
}

// `if __name__ == "__main__"`: Node resolves the invoked entry to its
// real path for import.meta.url while argv[1] keeps the typed spelling,
// so an invocation through a symlink must be resolved before comparing.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(pyResolve(process.argv[1])).href
) {
  process.exitCode = main();
}
