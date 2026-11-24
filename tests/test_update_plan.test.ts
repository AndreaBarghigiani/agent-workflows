/**
 * `scripts/update_plan.ts` (issue #119): `plan()` classification, flag
 * decisions and follow-ups over disposable consumer/submodule fixtures —
 * a library repo added as `.agent-workflows` — plus the dispatcher wiring
 * for `update` (native `--json` plan document, no envelope, exit statuses
 * 0 ready / 3 stop / 2 usage).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fileTree } from './testlib/tree.ts';
import * as install from '../scripts/install.ts';
import * as updatePlan from '../scripts/update_plan.ts';
import * as setupMemory from '../scripts/setup_memory.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCHER = join(REPO, 'bin/agent-workflows.ts');

const ENV = { ...process.env };
delete ENV.FORCE_COLOR;
delete ENV.NO_COLOR;

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function gitOk(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `git -C ${root} ${args.join(' ')}: ${result.stderr}`,
  );
  return (result.stdout as string).trim();
}

/**
 * The same read-only invocation the planner uses: no optional locks, no
 * lazy fetch and no fsmonitor hook, so observation alone never rewrites
 * an index, pulls a pack or runs a hook.
 */
function gitReadOnly(root: string, ...args: string[]): string {
  const result = spawnSync('git', [
    '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root,
    ...args,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
    },
  });
  assert.equal(
    result.status,
    0,
    `git -C ${root} ${args.join(' ')}: ${result.stderr}`,
  );
  return (result.stdout as string).trim();
}

function commit(root: string, message: string): void {
  gitOk(
    root,
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.invalid',
    'commit', '-qm', message,
  );
}

function runDispatcher(
  dispatcher: string,
  args: string[],
  cwd?: string,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [dispatcher, ...args], {
    cwd,
    encoding: 'utf8',
    env: ENV,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// -- Fixture ------------------------------------------------------------------

const ctx = {
  tmp: '',
  project: '',
  upstream: '',
  source: '',
  base: '',
  pin: '',
  target: '',
};

interface FixtureOptions {
  /** The old commit ships `scripts/t3_readiness.py`, the pin ships the
   * TypeScript dispatcher — the cutover the plan must detect. */
  pythonEraOld?: boolean;
  /** The target commit adds a third Codex profile. */
  targetProfile?: boolean;
  /** Copy the real `bin/` and `scripts/` trees into the library pin so the
   * fixture's own dispatcher is runnable. */
  dispatcher?: boolean;
  /** Which library commit the consumer records as its pin. */
  pinAt?: 'base' | 'pin';
  /** The library ships a reference-only skill from the base commit. */
  referenceSkill?: boolean;
  /** The target commit adds a reference-only skill. */
  targetReferenceSkill?: boolean;
  /** The target commit drops the review-issue skill. */
  targetDropsReview?: boolean;
  /** The target commit adds an extra toolkit skill. */
  targetSkill?: boolean;
  /** The base commit ignores `generated.txt` and the target tracks it —
   * an ignored file the adoption checkout must refuse to overwrite. */
  ignoredTarget?: boolean;
  /** The target commit predates the update command: 'script' removes
   * scripts/update_plan.ts, 'registration' drops the dispatcher's
   * update registration. */
  predatesPlanner?: 'script' | 'registration';
}

function skill(root: string, name: string): void {
  writeText(
    join(root, '.agents/skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name}.\n---\n# ${name}\n`,
  );
}

function profile(root: string, name: string): void {
  writeText(
    join(root, '.codex/agents', `${name}.toml`),
    `name = "${name}"\ndescription = "${name}"\n` +
      'developer_instructions = "review"\n',
  );
}

function buildFixture(options: FixtureOptions = {}): void {
  ctx.tmp = mkdtempSync(join(tmpdir(), 'update-plan-test-'));
  ctx.project = join(ctx.tmp, 'consumer');
  ctx.upstream = join(ctx.tmp, 'library-source');
  mkdirSync(ctx.project);
  mkdirSync(ctx.upstream);
  for (const root of [ctx.project, ctx.upstream]) gitOk(root, 'init', '-q');

  // Old revision. The library also ships the memory capability's skill;
  // toolkit() keeps it out of a routine refresh, but setup_memory's
  // preflight expects it at the pin.
  skill(ctx.upstream, 'shape-issue');
  skill(ctx.upstream, 'review-issue');
  skill(ctx.upstream, 'setup-basic-memory');
  if (options.referenceSkill) {
    writeText(
      join(ctx.upstream, '.agents/skills/local-note/SKILL.md'),
      '---\nname: local-note\ndescription: local-note.\n' +
        'distribution: reference-only\n---\n# local-note\n',
    );
  }
  profile(ctx.upstream, 'issue-reviewer');
  profile(ctx.upstream, 'plan-reviewer');
  if (options.pythonEraOld) {
    writeText(
      join(ctx.upstream, 'scripts/t3_readiness.py'),
      '# python-era readiness\n',
    );
  } else {
    writeText(
      join(ctx.upstream, 'bin/agent-workflows.ts'),
      '// dispatcher stub\n' +
        "import('../scripts/update_plan.ts');\n",
    );
    writeText(
      join(ctx.upstream, 'scripts/update_plan.ts'),
      '// planner stub\n',
    );
  }
  if (options.ignoredTarget) {
    writeText(join(ctx.upstream, '.gitignore'), 'generated.txt\n');
  }
  gitOk(ctx.upstream, 'add', '.');
  commit(ctx.upstream, 'library base');
  ctx.base = gitOk(ctx.upstream, 'rev-parse', 'HEAD');

  // Recorded pin revision.
  if (options.pythonEraOld) {
    gitOk(ctx.upstream, 'rm', '-q', 'scripts/t3_readiness.py');
    writeText(
      join(ctx.upstream, 'bin/agent-workflows.ts'),
      '// dispatcher stub\n',
    );
  } else if (options.dispatcher) {
    // The real dispatcher replaces the planner-carrying stub.
    gitOk(ctx.upstream, 'rm', '-q', 'bin/agent-workflows.ts');
    gitOk(ctx.upstream, 'rm', '-q', 'scripts/update_plan.ts');
    cpSync(join(REPO, 'bin'), join(ctx.upstream, 'bin'), {
      recursive: true,
    });
    cpSync(join(REPO, 'scripts'), join(ctx.upstream, 'scripts'), {
      recursive: true,
    });
  } else {
    writeText(join(ctx.upstream, 'CHANGELOG.md'), '# changelog\n');
  }
  gitOk(ctx.upstream, 'add', '.');
  commit(ctx.upstream, 'library pin');
  ctx.pin = gitOk(ctx.upstream, 'rev-parse', 'HEAD');

  // Later reviewed target.
  writeText(join(ctx.upstream, 'TARGET.md'), '# target\n');
  if (options.targetProfile) profile(ctx.upstream, 'extra-reviewer');
  if (options.targetSkill) skill(ctx.upstream, 'extra-skill');
  if (options.targetReferenceSkill) {
    writeText(
      join(ctx.upstream, '.agents/skills/shared-note/SKILL.md'),
      '---\nname: shared-note\ndescription: shared-note.\n' +
        'distribution: reference-only\n---\n# shared-note\n',
    );
  }
  if (options.targetDropsReview) {
    gitOk(ctx.upstream, 'rm', '-qr', '.agents/skills/review-issue');
  }
  if (options.ignoredTarget) {
    writeText(join(ctx.upstream, 'generated.txt'), '# generated\n');
    gitOk(ctx.upstream, 'add', '-f', 'generated.txt');
  }
  if (options.predatesPlanner === 'script') {
    gitOk(ctx.upstream, 'rm', '-q', 'scripts/update_plan.ts');
  } else if (options.predatesPlanner === 'registration') {
    writeText(
      join(ctx.upstream, 'bin/agent-workflows.ts'),
      '// dispatcher stub\n',
    );
  }
  gitOk(ctx.upstream, 'add', '.');
  commit(ctx.upstream, 'library target');
  ctx.target = gitOk(ctx.upstream, 'rev-parse', 'HEAD');
  gitOk(ctx.upstream, 'tag', 'v-test', ctx.target);

  gitOk(
    ctx.project,
    '-c', 'protocol.file.allow=always',
    'submodule', 'add', '-q', ctx.upstream, '.agent-workflows',
  );
  ctx.source = join(ctx.project, '.agent-workflows');
  gitOk(
    ctx.source,
    'checkout', '-q', '--detach',
    options.pinAt === 'base' ? ctx.base : ctx.pin,
  );
  writeText(join(ctx.project, 'AGENTS.md'), '# Consumer rules\n');
  gitOk(ctx.project, 'add', '.gitmodules', '.agent-workflows', 'AGENTS.md');
  commit(ctx.project, 'consumer pin');
}

function plan(target?: string | null): updatePlan.PlanDocument {
  return updatePlan.plan(ctx.source, ctx.project, { target });
}

function head(): string {
  return gitOk(ctx.source, 'rev-parse', 'HEAD');
}

/**
 * Replace the fixture's full submodule with a `tree:0` partial clone
 * checked out at `checkout`. Only that commit's trees are fetched; other
 * commits exist (tree:0 keeps commits) but their trees do not.
 */
function partialLibrary(checkout: string): void {
  gitOk(ctx.upstream, 'config', 'uploadpack.allowFilter', 'true');
  rmSync(ctx.source, { recursive: true, force: true });
  gitOk(
    ctx.tmp,
    'clone', '--quiet', '--no-checkout', '--filter=tree:0',
    `file://${ctx.upstream}`, ctx.source,
  );
  gitOk(ctx.source, 'checkout', '-q', '--detach', checkout);
  gitOk(ctx.project, 'add', '.agent-workflows');
}

function linkProfile(name: string, target = name): void {
  mkdirSync(join(ctx.project, '.codex/agents'), { recursive: true });
  symlinkSync(
    `../../.agent-workflows/.codex/agents/${target}.toml`,
    join(ctx.project, '.codex/agents', `${name}.toml`),
  );
}

function stopCodes(document: updatePlan.PlanDocument): string[] {
  return document.stops.map((stop) => stop.code);
}

function questionCodes(document: updatePlan.PlanDocument): string[] {
  return document.owner_questions.map((question) => question.code);
}

function decision(
  document: updatePlan.PlanDocument,
  flag: string,
): updatePlan.PlanDecision {
  const found = document.install.decisions.find(
    (entry) => entry.flag === flag,
  );
  assert.ok(found, `no decision for ${flag}`);
  return found;
}

function writeCapabilities(choice: string): void {
  writeText(
    join(ctx.project, '.agent-workflows-capabilities.json'),
    `{\n  "schema_version": 1,\n  "memory": ${JSON.stringify(choice)}\n}\n`,
  );
}

function writeT3Config(memory: unknown, choice = 'enabled'): void {
  writeText(
    join(ctx.project, '.agent-workflows-t3.json'),
    JSON.stringify({
      base: 'main',
      choice,
      library: '.agent-workflows',
      memory,
      profiles: [],
    }) + '\n',
  );
}

/**
 * Reviewed routing input in the helper's own format — the same shape as
 * `docs/memory/examples/*.toml` — never a placeholder `config.md` the
 * helper would refuse.
 */
const ROUTING_TOML = `schema_version = 2
[project]
id = "consumer"
[memory]
write_project = "consumer"
search_projects = ["consumer", "shared-engineering"]
related_projects = []
mcp_server = "basic_memory"
`;

function routingToml(clients?: string[]): string {
  if (clients === undefined) return ROUTING_TOML;
  return (
    ROUTING_TOML +
    '[connection]\n' +
    `clients = [${clients.map((client) => `"${client}"`).join(', ')}]\n`
  );
}

function generatedRouting(toml = ROUTING_TOML): string {
  const data = setupMemory.config_data(
    setupMemory.parse_routing(toml, 'test routing'),
  ) as Parameters<typeof setupMemory.policy>[0];
  return setupMemory.policy(data);
}

type RoutingState =
  | 'current'
  | 'missing'
  | 'stale'
  | 'python-era'
  | 'customized';

function writeRouting(
  instructions: RoutingState = 'current',
  clients?: string[],
): void {
  const toml = routingToml(clients);
  writeText(join(ctx.project, '.agents/memory/config.toml'), toml);
  const generated = generatedRouting(toml);
  const target = join(ctx.project, '.agents/memory/config.md');
  if (instructions === 'current') {
    writeText(target, generated);
  } else if (instructions === 'stale') {
    // An earlier generated variant: replaceable, therefore stale.
    writeText(target, setupMemory.previous_generated(generated)[0]);
  } else if (instructions === 'python-era') {
    // The exact text v0.4.0 through v0.5.0 generated: the connection
    // paragraph named the Python helper (#139).
    writeText(
      target,
      generated.replace(
        '`setup_memory_connections`',
        '`setup_memory_connections.py`',
      ),
    );
  } else if (instructions === 'customized') {
    writeText(target, '# hand-edited routing\n');
  }
}

function enableMemory(
  instructions: RoutingState = 'current',
  clients?: string[],
): void {
  writeCapabilities('enabled');
  writeRouting(instructions, clients);
}

function followUpKinds(document: updatePlan.PlanDocument): string[] {
  return document.follow_ups.map((entry) => entry.commands[0].split(' ')[2]);
}

// -- Pin state classification ----------------------------------------------------

describe('UpdatePlanTests', () => {
  beforeEach(() => {
    buildFixture();
  });

  afterEach(() => {
    rmSync(ctx.tmp, { recursive: true, force: true });
  });

  test('test_routine_refresh_is_ready', () => {
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.equal(document.library.state, 'at-pin');
    assert.deepEqual(document.stops, []);
    assert.equal(document.library.path, '.agent-workflows');
    assert.equal(document.library.index_pin, ctx.pin);
    assert.equal(document.library.committed_pin, ctx.pin);
    assert.equal(document.library.head, ctx.pin);
    assert.equal(document.library.branch, null);
    assert.equal(document.library.dirty, false);
    assert.equal(document.pins.old, ctx.pin);
    assert.equal(document.pins.new, null);
    assert.equal(
      document.install.command,
      'node .agent-workflows/bin/agent-workflows.ts install --project .',
    );
    assert.equal(
      document.install.check_command,
      'node .agent-workflows/bin/agent-workflows.ts install --project . --check',
    );
    assert.deepEqual(document.install.flags, []);
    assert.deepEqual(document.follow_ups, []);
    // A bare consumer leaves three questions for the owner; none block.
    assert.deepEqual(
      questionCodes(document).sort(),
      ['claude-skills', 'delivery-profiles', 'memory-choice'],
    );
  });

  test('test_attached_branch_at_pin_is_a_note_not_a_stop', () => {
    gitOk(ctx.source, 'checkout', '-qB', 'reviewed');
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.equal(document.library.branch, 'reviewed');
    assert.ok(
      document.notes.some(
        (note) => note.includes("'reviewed'") && note.includes('detaches'),
      ),
    );
  });

  test('test_staged_adoption_reports_old_and_new_pins', () => {
    gitOk(ctx.source, 'checkout', '-q', '--detach', ctx.target);
    gitOk(ctx.project, 'add', '.agent-workflows');
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.equal(document.library.state, 'adoption-staged');
    assert.equal(document.pins.old, ctx.pin);
    assert.equal(document.pins.new, ctx.target);
    assert.equal(document.pins.new_name, 'v-test');
    assert.ok(
      document.notes.some((note) => note.includes('already staged')),
    );
  });

  test('test_target_adoption_lists_steps_and_describe_names', () => {
    const document = plan(ctx.target);
    assert.equal(document.status, 'ready');
    assert.equal(document.library.state, 'at-pin');
    assert.equal(document.pins.old, ctx.pin);
    assert.equal(document.pins.new, ctx.target);
    assert.equal(document.pins.new_name, 'v-test');
    const adoption = document.follow_ups[0];
    assert.ok(adoption);
    assert.deepEqual(adoption.commands, [
      'git -C .agent-workflows checkout --no-overwrite-ignore' +
        ` --detach ${ctx.target}`,
      'git add .agent-workflows',
    ]);
    assert.ok(
      document.notes.some((note) => note.includes('rerun `update plan`')),
    );
    // A tag resolves to the same commit.
    const tagged = plan('v-test');
    assert.equal(tagged.pins.new, ctx.target);
  });

  test('test_target_matching_the_pin_adopts_nothing', () => {
    const document = plan(ctx.pin);
    assert.equal(document.status, 'ready');
    assert.equal(document.pins.new, null);
    assert.ok(
      document.notes.some((note) => note.includes('nothing to adopt')),
    );
    assert.deepEqual(document.follow_ups, []);
  });

  test('test_target_conflicting_with_a_staged_adoption_stops', () => {
    gitOk(ctx.source, 'checkout', '-q', '--detach', ctx.target);
    gitOk(ctx.project, 'add', '.agent-workflows');
    const document = plan(ctx.pin);
    assert.equal(document.status, 'stop');
    assert.deepEqual(stopCodes(document), ['target-mismatch']);
  });

  test('test_unresolvable_target_stops', () => {
    const document = plan('no-such-rev');
    assert.equal(document.status, 'stop');
    assert.deepEqual(stopCodes(document), ['target-unavailable']);
    assert.ok(
      document.stops[0].message.includes('Could not fetch'),
      document.stops[0].message,
    );
    assert.ok(
      document.stops[0].message.includes(ctx.upstream),
      document.stops[0].message,
    );
  });

  test('test_branch_target_is_fetched_over_a_stale_local_branch', () => {
    // The library's local branch still points at the clone-time tip; the
    // remote moved on. `--target <branch>` means the remote's branch.
    const branch = gitOk(ctx.upstream, 'symbolic-ref', '--short', 'HEAD');
    writeText(join(ctx.upstream, 'LATER.md'), '# later\n');
    gitOk(ctx.upstream, 'add', '.');
    commit(ctx.upstream, 'later');
    const later = gitOk(ctx.upstream, 'rev-parse', 'HEAD');
    gitOk(ctx.source, 'branch', '-f', branch, ctx.target);
    const document = plan(branch);
    assert.equal(document.status, 'ready', JSON.stringify(document.stops));
    assert.equal(document.pins.new, later);
    assert.ok(
      document.notes.some(
        (note) => note.includes('Fetched target') && note.includes(ctx.upstream),
      ),
      JSON.stringify(document.notes),
    );
  });

  test('test_target_only_on_the_remote_is_fetched', () => {
    writeText(join(ctx.upstream, 'REMOTE.md'), '# remote only\n');
    gitOk(ctx.upstream, 'add', '.');
    commit(ctx.upstream, 'remote only');
    gitOk(ctx.upstream, 'tag', 'v-remote');
    const remoteOnly = gitOk(ctx.upstream, 'rev-parse', 'HEAD');
    const document = plan('v-remote');
    assert.equal(document.status, 'ready', JSON.stringify(document.stops));
    assert.equal(document.pins.new, remoteOnly);
  });

  test('test_unreachable_submodule_url_is_a_target_stop', () => {
    const missing = join(ctx.tmp, 'gone.git');
    const name = gitOk(
      ctx.project,
      'config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$',
    ).split(' ')[0].slice('submodule.'.length, -'.path'.length);
    gitOk(ctx.project, 'config', `submodule.${name}.url`, missing);
    const document = plan('main');
    assert.equal(document.status, 'stop');
    assert.deepEqual(stopCodes(document), ['target-unavailable']);
    assert.ok(document.stops[0].message.includes(missing));
  });

  test('test_refspec_target_is_refused_without_writing_refs', () => {
    const refs = () => gitOk(ctx.source, 'for-each-ref', '--format=%(refname) %(objectname)');
    const before = refs();
    const document = plan('main:refs/heads/test');
    assert.equal(document.status, 'stop');
    assert.deepEqual(stopCodes(document), ['target-unavailable']);
    assert.ok(document.stops[0].message.includes('not a revision name'));
    assert.equal(refs(), before);
  });

  test('test_fetch_moves_no_local_or_remote_tracking_refs', () => {
    // A recorded URL naming the library's own remote would otherwise let
    // its configured fetch mapping move refs/remotes and local branches.
    const branch = gitOk(ctx.upstream, 'symbolic-ref', '--short', 'HEAD');
    writeText(join(ctx.upstream, 'MOVED.md'), '# moved\n');
    gitOk(ctx.upstream, 'add', '.');
    commit(ctx.upstream, 'moved');
    gitOk(
      ctx.source,
      'config', 'remote.origin.fetch', `+refs/heads/*:refs/heads/*`,
    );
    const name = gitOk(
      ctx.project,
      'config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$',
    ).split(' ')[0].slice('submodule.'.length, -'.path'.length);
    gitOk(ctx.project, 'config', `submodule.${name}.url`, 'origin');
    const refs = () => gitOk(ctx.source, 'for-each-ref', '--format=%(refname) %(objectname)');
    const before = refs();
    const document = plan(branch);
    assert.equal(document.status, 'ready', JSON.stringify(document.stops));
    assert.equal(refs(), before);
  });

  test('test_hex_named_branch_is_fetched_not_read_as_a_sha', () => {
    gitOk(ctx.source, 'branch', 'deadbeef', ctx.pin);
    writeText(join(ctx.upstream, 'HEX.md'), '# hex\n');
    gitOk(ctx.upstream, 'add', '.');
    commit(ctx.upstream, 'hex');
    const newer = gitOk(ctx.upstream, 'rev-parse', 'HEAD');
    gitOk(ctx.upstream, 'branch', 'deadbeef', newer);
    const document = plan('deadbeef');
    assert.equal(document.status, 'ready', JSON.stringify(document.stops));
    assert.equal(document.pins.new, newer);
  });

  test('test_relative_gitmodules_url_needs_submodule_init', () => {
    const name = gitOk(
      ctx.project,
      'config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$',
    ).split(' ')[0].slice('submodule.'.length, -'.path'.length);
    gitOk(ctx.project, 'config', '--unset', `submodule.${name}.url`);
    gitOk(
      ctx.project,
      'config', '-f', '.gitmodules', `submodule.${name}.url`, '../library.git',
    );
    const document = plan('v-test');
    assert.equal(document.status, 'stop');
    assert.ok(stopCodes(document).includes('target-unavailable'));
    const stop = document.stops.find((entry) => entry.code === 'target-unavailable');
    assert.ok(stop?.message.includes('git submodule init'), stop?.message);
  });

  test('test_fetch_runs_only_for_a_target_not_already_present', () => {
    const fetches = (target?: string) => {
      const calls: string[][] = [];
      updatePlan.plan(ctx.source, ctx.project, {
        target,
        runGitImpl: (root, args) => {
          calls.push(args);
          return updatePlan.runPlanGit(root, args);
        },
      });
      return calls.filter((args) => args.includes('fetch'));
    };
    assert.deepEqual(fetches(), [], 'a routine plan fetched');
    assert.deepEqual(fetches(ctx.target), [], 'a present SHA was fetched');
    // An abbreviated SHA cannot be fetched by name; the failed attempt
    // falls back to the commit the library already holds.
    const short = plan(ctx.target.slice(0, 12));
    assert.equal(short.pins.new, ctx.target, JSON.stringify(short.stops));
    const tagged = fetches('v-test');
    assert.equal(tagged.length, 1);
    for (const flag of ['--no-recurse-submodules', '--refmap=']) {
      assert.ok(tagged[0].includes(flag), JSON.stringify(tagged[0]));
    }
  });

  test('test_dirty_library_stops', () => {
    writeText(join(ctx.source, 'local.txt'), 'local\n');
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.equal(document.library.state, 'dirty');
    assert.equal(document.library.dirty, true);
    assert.deepEqual(stopCodes(document), ['dirty']);
    assert.equal(document.library.head, ctx.pin);
  });

  test('test_local_commits_ahead_of_pin_stop', () => {
    writeText(join(ctx.source, 'local.txt'), 'local\n');
    gitOk(ctx.source, 'add', 'local.txt');
    commit(ctx.source, 'local work');
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.equal(document.library.state, 'ahead');
    assert.deepEqual(stopCodes(document), ['ahead']);
    assert.notEqual(document.library.head, ctx.pin);
  });

  test('test_diverged_checkout_stops', () => {
    gitOk(ctx.source, 'checkout', '-q', '--detach', ctx.base);
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.equal(document.library.state, 'diverged');
    assert.deepEqual(stopCodes(document), ['diverged']);
  });

  test('test_unregistered_or_missing_pin_stops_not_pinned', () => {
    // The upstream checkout is outside the consumer.
    const outside = updatePlan.plan(ctx.upstream, ctx.project);
    assert.equal(outside.status, 'stop');
    assert.deepEqual(stopCodes(outside), ['not-pinned']);
    // A copied library directory inside the consumer is not a pin.
    const copy = join(ctx.project, 'library-copy');
    cpSync(ctx.source, copy, { recursive: true });
    const copied = updatePlan.plan(copy, ctx.project);
    assert.equal(copied.status, 'stop');
    assert.deepEqual(stopCodes(copied), ['not-pinned']);
  });

  test('test_uninitialized_submodule_names_the_init_command', () => {
    gitOk(ctx.project, 'submodule', 'deinit', '-q', '--force', '.agent-workflows');
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.equal(document.library.state, 'uninitialized');
    assert.deepEqual(stopCodes(document), ['uninitialized']);
    assert.ok(
      document.stops[0].message.includes(
        'git submodule update --init -- .agent-workflows',
      ),
    );
  });

  test('test_plan_leaves_checkout_index_and_objects_identical', () => {
    const libGitPath = (name: string) =>
      resolve(ctx.source, gitOk(ctx.source, 'rev-parse', '--git-path', name));
    const libIndex = libGitPath('index');
    const libObjects = libGitPath('objects');
    const consumerIndex = join(ctx.project, '.git', 'index');
    const consumerObjects = join(ctx.project, '.git', 'objects');
    // Raw bytes first: an index refresh rewrites stat info without
    // changing ls-files output, so bytes are the honest comparison. The
    // snapshot's own git reads run without optional locks so they cannot
    // mask a write the planner makes.
    const snapshot = () => ({
      consumerIndexBytes: readFileSync(consumerIndex),
      libIndexBytes: readFileSync(libIndex),
      consumerObjects: fileTree(consumerObjects),
      libObjects: fileTree(libObjects),
      tree: fileTree(ctx.project, /^\.git(\/|$)/),
      status: gitReadOnly(
        ctx.project,
        'status', '--porcelain', '--untracked-files=all',
      ),
      index: gitReadOnly(ctx.project, 'ls-files', '-s'),
      head: gitReadOnly(ctx.project, 'rev-parse', 'HEAD'),
      libStatus: gitReadOnly(
        ctx.source,
        'status', '--porcelain', '--untracked-files=all',
      ),
      libIndex: gitReadOnly(ctx.source, 'ls-files', '-s'),
      libHead: gitReadOnly(ctx.source, 'rev-parse', 'HEAD'),
    });
    // A touched library file — same bytes, new mtime — must report clean
    // and still leave the index untouched.
    const touched = join(
      ctx.source,
      '.agents/skills/shape-issue/SKILL.md',
    );
    const now = new Date();
    utimesSync(touched, now, now);
    const before = snapshot();
    const document = plan(ctx.target);
    assert.equal(document.library.dirty, false);
    const after = snapshot();
    assert.ok(
      after.consumerIndexBytes.equals(before.consumerIndexBytes),
      'consumer index bytes changed',
    );
    assert.ok(
      after.libIndexBytes.equals(before.libIndexBytes),
      'library index bytes changed',
    );
    for (const [name, objects] of [
      ['consumer', [before.consumerObjects, after.consumerObjects]],
      ['library', [before.libObjects, after.libObjects]],
    ] as const) {
      const [wanted, actual] = objects;
      assert.deepEqual(
        [...actual.keys()].sort(),
        [...wanted.keys()].sort(),
        `${name} object store listing changed`,
      );
      for (const [path, entry] of wanted) {
        assert.ok(
          actual.get(path)?.bytes.equals(entry.bytes),
          `${name} object ${path} changed`,
        );
      }
    }
    assert.deepEqual([...after.tree.keys()], [...before.tree.keys()]);
    for (const [path, entry] of before.tree) {
      const actual = after.tree.get(path);
      assert.ok(actual, `${path} disappeared`);
      assert.equal(actual.kind, entry.kind, `${path} kind changed`);
      assert.ok(actual.bytes.equals(entry.bytes), `${path} bytes changed`);
    }
    assert.equal(after.status, before.status);
    assert.equal(after.index, before.index);
    assert.equal(after.head, before.head);
    assert.equal(after.libStatus, before.libStatus);
    assert.equal(after.libIndex, before.libIndex);
    assert.equal(after.libHead, before.libHead);
  });

  test('test_partial_clone_reads_missing_objects_from_its_remote', () => {
    // A tree:0 partial clone lacks the target's tree; the plan reads it
    // from the clone's promisor remote, as the owner's own Git does,
    // instead of stopping. (`base` stands in for the target: the clone
    // backfilled the remote tip's objects, so only a non-tip commit's
    // tree is missing.)
    partialLibrary(ctx.pin);
    const document = plan(ctx.base);
    assert.ok(
      !stopCodes(document).includes('objects-unavailable'),
      JSON.stringify(document.stops),
    );
    assert.equal(document.pins.new, ctx.base);
  });

  test('test_partial_clone_old_pin_tree_is_read_for_the_codex_lookup', () => {
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ pinAt: 'base' });
    // A staged adoption to `pin`: the recorded (committed) pin stays
    // `base`, whose tree the partial clone lacks. With a partial
    // profile selection the codex decision needs that old set.
    partialLibrary(ctx.pin);
    linkProfile('issue-reviewer');
    const document = plan();
    assert.ok(
      !stopCodes(document).includes('objects-unavailable'),
      JSON.stringify(document.stops),
    );
  });

  test('test_configured_filter_drivers_do_not_stop_the_plan', () => {
    // Git LFS installs `filter.lfs.*` drivers machine-wide (CI runners
    // do). The plan's `git status` runs configured drivers as the
    // owner's own status does, so a configured driver is not a stop.
    gitOk(ctx.source, 'config', 'filter.lfs.clean', 'cat');
    gitOk(ctx.source, 'config', 'filter.lfs.process', 'false');
    gitOk(ctx.source, 'config', 'filter.lfs.required', 'false');
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.equal(document.library.dirty, false);
  });

  test('test_nested_submodule_stops_before_status', () => {
    // The plan does not inspect nested checkouts: the index gitlink
    // read is pure, so the plan stops and names the nested path before
    // status could enter it.
    const nested = join(ctx.tmp, 'nested-source');
    mkdirSync(nested);
    gitOk(nested, 'init', '-q');
    writeText(join(nested, '.gitattributes'), '*.txt filter=marker\n');
    writeText(join(nested, 'file.txt'), 'x\n');
    gitOk(nested, 'add', '.');
    commit(nested, 'nested base');
    gitOk(
      ctx.source,
      '-c', 'protocol.file.allow=always',
      'submodule', 'add', '-q', nested, 'nested',
    );
    const marker = join(ctx.tmp, 'nested-clean-filter-ran');
    gitOk(
      join(ctx.source, 'nested'),
      'config', 'filter.marker.clean',
      `cat && touch ${marker}`,
    );
    const touched = join(ctx.source, 'nested', 'file.txt');
    const now = new Date();
    utimesSync(touched, now, now);
    const libIndex = resolve(
      ctx.source,
      gitOk(ctx.source, 'rev-parse', '--git-path', 'index'),
    );
    const indexBytes = readFileSync(libIndex);
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.equal(document.library.state, 'nested-submodules');
    assert.equal(document.library.dirty, null);
    assert.deepEqual(stopCodes(document), ['nested-submodules']);
    assert.ok(
      document.stops[0].message.includes('nested'),
      document.stops[0].message,
    );
    assert.ok(
      document.stops[0].message.includes(
        'git -C .agent-workflows/nested status',
      ),
      document.stops[0].message,
    );
    assert.ok(!existsSync(marker), 'the nested clean filter ran');
    assert.ok(
      readFileSync(libIndex).equals(indexBytes),
      'library index bytes changed',
    );
  });

  test('test_fsmonitor_hook_is_disabled_for_read_only_git', () => {
    // A configured fsmonitor hook is owner code; every planner git call
    // passes `-c core.fsmonitor=false`, so the status inspection never
    // invokes it.
    const marker = join(ctx.tmp, 'fsmonitor-ran');
    gitOk(ctx.source, 'config', 'core.fsmonitor', `touch ${marker}`);
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.equal(document.library.dirty, false);
    assert.ok(!existsSync(marker), 'the fsmonitor hook ran');
  });

  test('test_inspection_failures_become_structured_stops', () => {
    // An OSError-class failure inside planning is a normal stop plan —
    // exit 3 with a printed document — never exit 1 with empty stdout.
    const failure = Object.assign(new Error('simulated OS failure'), {
      code: 'EIO',
    });
    const document = updatePlan.plan(ctx.source, ctx.project, {
      runGitImpl: () => {
        throw failure;
      },
    });
    assert.equal(document.status, 'stop');
    assert.deepEqual(stopCodes(document), ['inspection-error']);
    assert.ok(
      document.stops[0].message.includes('simulated OS failure'),
      document.stops[0].message,
    );
    assert.match(
      updatePlan.renderText(document),
      /stop \[inspection-error\]/,
    );
  });
});

// -- Install flag decisions -----------------------------------------------------

describe('FlagDecisionTests', () => {
  beforeEach(() => {
    buildFixture();
  });

  afterEach(() => {
    rmSync(ctx.tmp, { recursive: true, force: true });
  });

  test('test_codex_agents_complete_selection_passes', () => {
    linkProfile('issue-reviewer');
    linkProfile('plan-reviewer');
    const document = plan();
    assert.equal(decision(document, '--codex-agents').applies, true);
    assert.ok(document.install.flags.includes('--codex-agents'));
    assert.ok(
      document.install.command.includes('--codex-agents'),
      document.install.command,
    );
  });

  test('test_codex_agents_partial_selection_is_preserved', () => {
    linkProfile('issue-reviewer');
    const document = plan();
    assert.equal(decision(document, '--codex-agents').applies, false);
    assert.ok(!document.install.flags.includes('--codex-agents'));
    assert.ok(
      document.notes.some((note) =>
        note.includes('partial profile selection preserved')
      ),
    );
  });

  test('test_codex_agents_none_is_not_passed', () => {
    const document = plan();
    assert.equal(decision(document, '--codex-agents').applies, false);
    assert.ok(
      !document.notes.some((note) => note.includes('partial profile')),
    );
  });

  test('test_codex_agents_old_set_coverage_passes', () => {
    // The consumer links the complete OLD profile set while the target
    // adds a third profile: the flag still applies.
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ targetProfile: true });
    linkProfile('issue-reviewer');
    linkProfile('plan-reviewer');
    const document = plan(ctx.target);
    assert.equal(decision(document, '--codex-agents').applies, true);
    assert.equal(document.pins.new, ctx.target);
  });

  test('test_codex_agents_swapped_link_is_a_conflict_not_coverage', () => {
    // .codex/agents/issue-reviewer.toml resolving to the plan-reviewer
    // profile is a conflict the installer refuses, not coverage.
    linkProfile('issue-reviewer', 'plan-reviewer');
    const document = plan();
    assert.equal(decision(document, '--codex-agents').applies, false);
    assert.ok(!document.install.flags.includes('--codex-agents'));
    assert.ok(
      document.notes.some(
        (note) =>
          note.includes('conflicting .codex/agents link') &&
          note.includes('issue-reviewer.toml'),
      ),
      document.notes.join('\n'),
    );
  });

  test('test_codex_agents_complete_set_with_stale_extra_links_passes', () => {
    linkProfile('issue-reviewer');
    linkProfile('plan-reviewer');
    // A stale same-name link to a profile the library no longer ships is
    // not a managed destination; the complete set still passes.
    symlinkSync(
      '../../.agent-workflows/.codex/agents/retired.toml',
      join(ctx.project, '.codex/agents/retired.toml'),
    );
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.equal(decision(document, '--codex-agents').applies, true);
    assert.ok(document.install.flags.includes('--codex-agents'));
  });

  test('test_codex_agents_swapped_link_at_a_managed_destination_stops', () => {
    // The recorded pin's complete set is linked so --codex-agents
    // applies; the install would touch the target's extra profile and
    // refuse its swapped link — the plan stops instead of noting it.
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ targetProfile: true });
    linkProfile('issue-reviewer');
    linkProfile('plan-reviewer');
    linkProfile('extra-reviewer', 'plan-reviewer');
    const document = plan(ctx.target);
    assert.equal(document.status, 'stop');
    assert.ok(document.install.flags.includes('--codex-agents'));
    assert.ok(stopCodes(document).includes('link-conflict'));
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'link-conflict' &&
          stop.message.includes('.codex/agents/extra-reviewer.toml'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
    // The managed conflict is the stop, not a duplicated note.
    assert.ok(
      !document.notes.some(
        (note) =>
          note.includes('conflicting .codex/agents link') &&
          note.includes('extra-reviewer.toml'),
      ),
    );
  });

  test('test_codex_agents_local_profile_file_is_preserved_not_a_stop', () => {
    // Codex profile destinations allow a local file (allowLocal): a
    // real file at the extra profile path is preserved, not refused.
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ targetProfile: true });
    linkProfile('issue-reviewer');
    linkProfile('plan-reviewer');
    writeText(
      join(ctx.project, '.codex/agents/extra-reviewer.toml'),
      'name = "extra-reviewer"\n',
    );
    const document = plan(ctx.target);
    assert.equal(document.status, 'ready');
    assert.ok(document.install.flags.includes('--codex-agents'));
    assert.ok(!stopCodes(document).includes('link-conflict'));
  });

  test('test_consumer_owned_dir_at_managed_skill_path_stops', () => {
    // A real directory at a managed .agents/skills destination is the
    // "occupied" classification install refuses.
    writeText(
      join(ctx.project, '.agents/skills/review-issue/SKILL.md'),
      '---\nname: review-issue\ndescription: local.\n---\n# local\n',
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(stopCodes(document).includes('link-conflict'));
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'link-conflict' &&
          stop.message.includes('.agents/skills/review-issue'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_conflicting_skill_link_at_managed_path_stops', () => {
    // A symlink resolving elsewhere at a managed skill destination is
    // the "conflict" classification install refuses.
    mkdirSync(join(ctx.project, '.agents/skills'), { recursive: true });
    writeText(
      join(ctx.project, 'local-skills/local/SKILL.md'),
      '---\nname: local\ndescription: local.\n---\n# local\n',
    );
    symlinkSync(
      '../../local-skills/local',
      join(ctx.project, '.agents/skills/review-issue'),
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(stopCodes(document).includes('link-conflict'));
  });

  test('test_target_dropped_skill_consumer_dir_is_not_stopped', () => {
    // The reviewer's reproduction: the reviewed target drops
    // review-issue, so its consumer directory is not a managed
    // destination the adopted install would touch — no refusal.
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ targetDropsReview: true });
    writeText(
      join(ctx.project, '.agents/skills/review-issue/SKILL.md'),
      '---\nname: review-issue\ndescription: local.\n---\n# local\n',
    );
    // At the recorded pin the same directory still blocks the install.
    const pinned = plan();
    assert.equal(pinned.status, 'stop');
    assert.ok(stopCodes(pinned).includes('link-conflict'));
    const document = plan(ctx.target);
    assert.equal(document.status, 'ready');
    assert.ok(!stopCodes(document).includes('link-conflict'));
    assert.equal(document.pins.new, ctx.target);
  });

  test('test_target_added_skill_consumer_dir_stops', () => {
    // The same destination toolkit in the other direction: a skill the
    // target adds is managed, so a consumer directory at its path is a
    // refusal under the adopted revision even though the pin is fine.
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ targetSkill: true });
    writeText(
      join(ctx.project, '.agents/skills/extra-skill/SKILL.md'),
      '---\nname: extra-skill\ndescription: local.\n---\n# local\n',
    );
    const pinned = plan();
    assert.equal(pinned.status, 'ready');
    const document = plan(ctx.target);
    assert.equal(document.status, 'stop');
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'link-conflict' &&
          stop.message.includes('.agents/skills/extra-skill'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_target_dropped_skill_library_link_stops', () => {
    // A link resolving into the library at a name the adopted toolkit
    // drops is install's "Stale library skill link" refusal — not a
    // managed destination, but still a conflict to surface.
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ targetDropsReview: true });
    mkdirSync(join(ctx.project, '.agents/skills'), { recursive: true });
    symlinkSync(
      '../../.agent-workflows/.agents/skills/review-issue',
      join(ctx.project, '.agents/skills/review-issue'),
    );
    // At the recorded pin the same link is a managed destination.
    const pinned = plan();
    assert.equal(pinned.status, 'ready');
    const document = plan(ctx.target);
    assert.equal(document.status, 'stop');
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'link-conflict' &&
          stop.message.includes('Stale library skill link') &&
          stop.message.includes('.agents/skills/review-issue'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_self_referential_skill_link_is_a_link_conflict_stop', () => {
    // A symlink loop at a managed destination is a conflict the
    // installer refuses, not an inspection crash.
    mkdirSync(join(ctx.project, '.agents/skills'), { recursive: true });
    symlinkSync(
      'review-issue',
      join(ctx.project, '.agents/skills/review-issue'),
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'link-conflict' &&
          stop.message.includes('.agents/skills/review-issue'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_linked_claude_md_stops_when_claude_skills_applies', () => {
    // install's CLAUDE.md preflight mirrors into the plan when
    // --claude-skills applies: a linked CLAUDE.md without the AGENTS.md
    // import is a refusal.
    mkdirSync(join(ctx.project, '.claude/skills'), { recursive: true });
    symlinkSync(
      '../../.agent-workflows/.agents/skills/shape-issue',
      join(ctx.project, '.claude/skills/shape-issue'),
    );
    writeText(join(ctx.project, 'notes.md'), '# notes\n');
    symlinkSync('notes.md', join(ctx.project, 'CLAUDE.md'));
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(document.install.flags.includes('--claude-skills'));
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'claude-instructions' &&
          stop.message.includes('CLAUDE.md'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_reference_only_skill_installed_as_link_stops', () => {
    // A managed link for a reference-only skill is an install refusal:
    // the skill stays library-side behind a pointer block.
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ referenceSkill: true });
    mkdirSync(join(ctx.project, '.agents/skills'), { recursive: true });
    symlinkSync(
      '../../.agent-workflows/.agents/skills/local-note',
      join(ctx.project, '.agents/skills/local-note'),
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(stopCodes(document).includes('link-conflict'));
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'link-conflict' &&
          stop.message.includes('.agents/skills/local-note'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_consumer_owned_claude_mirror_dir_stops_when_flag_applies', () => {
    // With the mirror detected, .claude/skills destinations are managed:
    // a consumer-owned directory there is a refusal.
    mkdirSync(join(ctx.project, '.claude/skills'), { recursive: true });
    symlinkSync(
      '../../.agent-workflows/.agents/skills/shape-issue',
      join(ctx.project, '.claude/skills/shape-issue'),
    );
    writeText(
      join(ctx.project, '.claude/skills/review-issue/SKILL.md'),
      '---\nname: review-issue\ndescription: local.\n---\n# local\n',
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(document.install.flags.includes('--claude-skills'));
    assert.ok(stopCodes(document).includes('link-conflict'));
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'link-conflict' &&
          stop.message.includes('.claude/skills/review-issue'),
      ),
    );
  });

  test('test_claude_skills_mirror_passes', () => {
    mkdirSync(join(ctx.project, '.claude/skills'), { recursive: true });
    symlinkSync(
      '../../.agent-workflows/.agents/skills/shape-issue',
      join(ctx.project, '.claude/skills/shape-issue'),
    );
    const document = plan();
    assert.equal(decision(document, '--claude-skills').applies, true);
    assert.ok(document.install.flags.includes('--claude-skills'));
    assert.ok(!questionCodes(document).includes('claude-skills'));
  });

  test('test_claude_skills_via_consumer_links_passes', () => {
    mkdirSync(join(ctx.project, '.claude/skills'), { recursive: true });
    mkdirSync(join(ctx.project, '.agents/skills'), { recursive: true });
    symlinkSync(
      '../../.agent-workflows/.agents/skills/shape-issue',
      join(ctx.project, '.agents/skills/shape-issue'),
    );
    symlinkSync(
      '../../.agents/skills/shape-issue',
      join(ctx.project, '.claude/skills/shape-issue'),
    );
    const document = plan();
    assert.equal(decision(document, '--claude-skills').applies, true);
  });

  test('test_claude_skills_consumer_owned_link_does_not_count', () => {
    mkdirSync(join(ctx.project, '.claude/skills'), { recursive: true });
    writeText(
      join(ctx.project, 'local-skills/local/SKILL.md'),
      '---\nname: local\ndescription: local.\n---\n# local\n',
    );
    symlinkSync(
      '../../local-skills/local',
      join(ctx.project, '.claude/skills/local'),
    );
    const document = plan();
    assert.equal(decision(document, '--claude-skills').applies, false);
    assert.ok(questionCodes(document).includes('claude-skills'));
  });

  test('test_claude_skills_swapped_library_link_does_not_count', () => {
    mkdirSync(join(ctx.project, '.claude/skills'), { recursive: true });
    // .claude/skills/review-issue resolving to the shape-issue skill is
    // not the link install would create.
    symlinkSync(
      '../../.agent-workflows/.agents/skills/shape-issue',
      join(ctx.project, '.claude/skills/review-issue'),
    );
    const document = plan();
    assert.equal(decision(document, '--claude-skills').applies, false);
  });

  test('test_claude_skills_non_toolkit_library_link_does_not_count', () => {
    mkdirSync(join(ctx.project, '.claude/skills'), { recursive: true });
    // The link text names the library skill root but no toolkit skill —
    // install would never create it.
    symlinkSync(
      '../../.agent-workflows/.agents/skills/retired-skill',
      join(ctx.project, '.claude/skills/retired-skill'),
    );
    const document = plan();
    assert.equal(decision(document, '--claude-skills').applies, false);
  });

  test('test_claude_skills_absent_asks_the_owner', () => {
    const document = plan();
    assert.equal(decision(document, '--claude-skills').applies, false);
    const question = document.owner_questions.find(
      (entry) => entry.code === 'claude-skills',
    );
    assert.ok(question);
    assert.ok(question.message.includes('explicitly selects'));
  });

  test('test_claude_skills_question_carries_the_import_refusal', () => {
    // install's CLAUDE.md preflight runs for the owner question too: a
    // linked CLAUDE.md without an AGENTS.md import would be refused —
    // the question carries the refusal so the owner resolves it first.
    writeText(join(ctx.project, 'notes.md'), '# notes\n');
    symlinkSync('notes.md', join(ctx.project, 'CLAUDE.md'));
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.equal(decision(document, '--claude-skills').applies, false);
    assert.ok(!document.install.flags.includes('--claude-skills'));
    const question = document.owner_questions.find(
      (entry) => entry.code === 'claude-skills',
    );
    assert.ok(question, 'expected a claude-skills question');
    assert.ok(
      question.message.includes('selecting Claude would be refused'),
      question.message,
    );
    assert.ok(
      question.message.includes(
        'Linked Claude instructions need an AGENTS.md import',
      ),
      question.message,
    );
    assert.ok(question.message.includes('resolve first'), question.message);
  });

  test('test_claude_skills_question_carries_the_conditional_edit', () => {
    // A regular CLAUDE.md without the import is no refusal: selecting
    // Claude would add the @AGENTS.md import — the question says so.
    writeText(join(ctx.project, 'CLAUDE.md'), '# Claude rules\n');
    const document = plan();
    assert.equal(document.status, 'ready');
    const question = document.owner_questions.find(
      (entry) => entry.code === 'claude-skills',
    );
    assert.ok(question, 'expected a claude-skills question');
    assert.ok(
      question.message.includes('selecting Claude adds `@AGENTS.md` to'),
      question.message,
    );
    assert.ok(question.message.includes('CLAUDE.md'), question.message);
  });

  test('test_claude_skills_question_carries_a_mirror_conflict', () => {
    // The conditional mirror preflight attaches install's link refusal:
    // a consumer-owned file at a managed .claude/skills destination.
    writeText(
      join(ctx.project, '.claude/skills/shape-issue/SKILL.md'),
      '---\nname: shape-issue\ndescription: local.\n---\n# local\n',
    );
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.equal(decision(document, '--claude-skills').applies, false);
    const question = document.owner_questions.find(
      (entry) => entry.code === 'claude-skills',
    );
    assert.ok(question, 'expected a claude-skills question');
    assert.ok(
      question.message.includes('selecting Claude would be refused'),
      question.message,
    );
    assert.ok(
      question.message.includes('Local skill conflict'),
      question.message,
    );
  });

  test('test_delivery_profiles_missing_asks_the_owner', () => {
    const document = plan();
    assert.equal(
      decision(document, '--delivery-profiles').applies,
      'owner',
    );
    const question = document.owner_questions.find(
      (entry) => entry.code === 'delivery-profiles',
    );
    assert.ok(question);
    assert.ok(!document.install.flags.includes('--delivery-profiles'));
  });

  test('test_delivery_profiles_present_is_preserved', () => {
    writeText(join(ctx.project, '.agents/delivery-profiles.json'), '{}\n');
    const document = plan();
    assert.equal(
      decision(document, '--delivery-profiles').applies,
      false,
    );
    assert.ok(
      document.notes.some((note) => note.includes('preserved byte-for-byte')),
    );
    assert.ok(!questionCodes(document).includes('delivery-profiles'));
  });

  test('test_delivery_profiles_dangling_symlink_is_preserved', () => {
    // lstat sees the entry even though its target is missing: it is an
    // existing consumer-owned file, never a fresh offer.
    mkdirSync(join(ctx.project, '.agents'), { recursive: true });
    symlinkSync(
      'missing-target.json',
      join(ctx.project, '.agents/delivery-profiles.json'),
    );
    const document = plan();
    assert.equal(
      decision(document, '--delivery-profiles').applies,
      false,
    );
    assert.ok(
      document.notes.some((note) => note.includes('preserved byte-for-byte')),
    );
    assert.ok(!questionCodes(document).includes('delivery-profiles'));
  });

  test('test_generated_commands_shell_quote_paths', () => {
    gitOk(ctx.project, 'mv', '.agent-workflows', 'toolkit path');
    commit(ctx.project, 'rename library');
    ctx.source = join(ctx.project, 'toolkit path');
    const document = plan(ctx.target);
    assert.equal(document.status, 'ready');
    const adoption = document.follow_ups[0];
    assert.ok(adoption);
    assert.deepEqual(adoption.commands, [
      `git -C 'toolkit path' checkout --no-overwrite-ignore` +
        ` --detach ${ctx.target}`,
      `git add 'toolkit path'`,
    ]);
    assert.ok(
      document.install.command.includes(
        `'toolkit path/bin/agent-workflows.ts'`,
      ),
      document.install.command,
    );
  });

  test('test_non_ascii_library_path_reads_the_committed_pin', () => {
    // Git quotes non-ASCII/space paths in display output; the committed
    // pin lookup parses NUL-delimited records so the raw path matches.
    gitOk(ctx.project, 'mv', '.agent-workflows', 'bibliothèque workflows');
    commit(ctx.project, 'rename library');
    ctx.source = join(ctx.project, 'bibliothèque workflows');
    const document = plan(ctx.target);
    assert.equal(document.status, 'ready');
    assert.equal(document.library.state, 'at-pin');
    assert.equal(document.library.path, 'bibliothèque workflows');
    assert.equal(document.library.committed_pin, ctx.pin);
    assert.equal(document.pins.new, ctx.target);
    const adoption = document.follow_ups[0];
    assert.ok(adoption);
    assert.deepEqual(adoption.commands, [
      `git -C 'bibliothèque workflows' checkout --no-overwrite-ignore` +
        ` --detach ${ctx.target}`,
      `git add 'bibliothèque workflows'`,
    ]);
    assert.ok(
      document.install.command.includes(
        `'bibliothèque workflows/bin/agent-workflows.ts'`,
      ),
      document.install.command,
    );
  });

  test('test_memory_declined_is_reported_not_passed', () => {
    writeCapabilities('declined');
    const document = plan();
    const memory = decision(document, '--memory');
    assert.equal(memory.applies, false);
    assert.ok(memory.reason.includes("'declined'"));
    assert.ok(!questionCodes(document).includes('memory-choice'));
    assert.deepEqual(document.follow_ups, []);
  });

  test('test_memory_unreadable_capabilities_stops', () => {
    writeText(
      join(ctx.project, '.agent-workflows-capabilities.json'),
      'not json\n',
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(stopCodes(document).includes('capabilities'));
  });
});

// -- Memory and T3 follow-ups ------------------------------------------------------

describe('FollowUpTests', () => {
  beforeEach(() => {
    buildFixture();
  });

  afterEach(() => {
    rmSync(ctx.tmp, { recursive: true, force: true });
  });

  test('test_claude_question_carries_a_memory_mirror_conflict', () => {
    // Memory enabled and no toolkit mirror: an owner-managed
    // .claude/skills/setup-basic-memory would make setup_memory
    // --claude-skills refuse, so the Claude question carries it.
    enableMemory();
    writeText(
      join(ctx.project, '.claude/skills/setup-basic-memory/SKILL.md'),
      '---\nname: setup-basic-memory\ndescription: local.\n---\n# local\n',
    );
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.equal(decision(document, '--claude-skills').applies, false);
    assert.ok(followUpKinds(document).includes('setup_memory'));
    const question = document.owner_questions.find(
      (entry) => entry.code === 'claude-skills',
    );
    assert.ok(question, 'expected a claude-skills question');
    assert.ok(
      question.message.includes('selecting Claude would be refused') &&
        question.message.includes('setup-basic-memory'),
      question.message,
    );
  });

  test('test_memory_enabled_plans_setup_and_preflight', () => {
    enableMemory();
    const document = plan();
    assert.equal(document.status, 'ready');
    const kinds = followUpKinds(document);
    assert.deepEqual(kinds, ['setup_memory', 'memory_preflight']);
    const setup = document.follow_ups[0];
    // Nothing under .agents/memory/ is tracked and .gitignore lacks the
    // line: sharing intent is undecided, so the plan asks the owner
    // instead of inferring --share-config.
    assert.ok(!setup.commands[0].includes('--share-config'));
    assert.ok(setup.commands[1].endsWith('--check'));
    assert.ok(!setup.commands[0].includes('--portable'));
    assert.ok(!setup.commands[0].includes('--claude-skills'));
    const question = document.owner_questions.find(
      (entry) => entry.code === 'memory-share-config',
    );
    assert.ok(question, 'expected a memory-share-config question');
    assert.ok(question.message.includes('/.agents/memory/'));
    assert.ok(
      question.message.includes('both setup_memory commands'),
      question.message,
    );
  });

  test('test_memory_setup_passes_share_config_when_memory_is_tracked', () => {
    // Anything under .agents/memory/ tracked in the consumer index is
    // established intent to share the directory.
    enableMemory();
    gitOk(ctx.project, 'add', '.agents/memory');
    const document = plan();
    const setup = document.follow_ups.find((entry) =>
      entry.commands[0].includes('setup_memory'),
    );
    assert.ok(setup);
    assert.ok(setup.commands[0].includes('--share-config'));
    assert.ok(setup.commands[1].includes('--share-config'));
    assert.ok(!questionCodes(document).includes('memory-share-config'));
  });

  test('test_memory_setup_omits_share_config_when_ignored', () => {
    enableMemory();
    writeText(join(ctx.project, '.gitignore'), '/.agents/memory/\n');
    const document = plan();
    const setup = document.follow_ups.find((entry) =>
      entry.commands[0].includes('setup_memory'),
    );
    assert.ok(setup);
    assert.ok(!setup.commands[0].includes('--share-config'));
    assert.ok(!questionCodes(document).includes('memory-share-config'));
  });

  test('test_memory_setup_mirrors_the_claude_decision', () => {
    enableMemory();
    mkdirSync(join(ctx.project, '.claude/skills'), { recursive: true });
    symlinkSync(
      '../../.agent-workflows/.agents/skills/shape-issue',
      join(ctx.project, '.claude/skills/shape-issue'),
    );
    const document = plan();
    const setup = document.follow_ups.find((entry) =>
      entry.commands[0].includes('setup_memory'),
    );
    assert.ok(setup);
    assert.ok(setup.commands[0].includes('--claude-skills'));
    assert.ok(!setup.commands[0].includes('--share-config'));
    assert.ok(setup.commands[1].includes('--claude-skills'));
    assert.ok(questionCodes(document).includes('memory-share-config'));
  });

  test('test_memory_connection_opt_in_notes_effects_and_asks_for_profile', () => {
    // A reviewed [connection] table opts into generated client
    // connection files: the plan names setup_memory's effects on this
    // checkout and asks for the machine-local profile when absent.
    const xdg = join(ctx.tmp, 'xdg');
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      enableMemory('current', ['claude', 'codex']);
      const document = plan();
      assert.equal(document.status, 'ready');
      const note = document.notes.find((entry) =>
        entry.includes('connection profile'),
      );
      assert.ok(note, document.notes.join('\n'));
      assert.ok(
        note.includes(
          join(xdg, 'agent-workflows', 'memory-connection.toml'),
        ),
        note,
      );
      assert.ok(note.includes('.mcp.json'), note);
      assert.ok(note.includes('.codex/config.toml'), note);
      assert.ok(!note.includes('opencode.json'), note);
      assert.ok(note.includes('connection drift'), note);
      const question = document.owner_questions.find(
        (entry) => entry.code === 'memory-connection-profile',
      );
      assert.ok(question, 'expected a memory-connection-profile question');
      assert.ok(
        question.message.includes('never creates credentials'),
        question.message,
      );
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  test('test_memory_connection_profile_present_is_a_note_only', () => {
    const xdg = join(ctx.tmp, 'xdg');
    writeText(
      join(xdg, 'agent-workflows', 'memory-connection.toml'),
      'schema_version = 1\nendpoint = "https://memory.example.invalid"\n',
    );
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      enableMemory('current', ['opencode']);
      const document = plan();
      assert.equal(document.status, 'ready');
      const note = document.notes.find((entry) =>
        entry.includes('connection profile'),
      );
      assert.ok(note, document.notes.join('\n'));
      assert.ok(note.includes('opencode.json'), note);
      assert.ok(
        !questionCodes(document).includes('memory-connection-profile'),
      );
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  test('test_memory_enabled_without_routing_stops', () => {
    writeCapabilities('enabled');
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(stopCodes(document).includes('memory-routing-missing'));
    assert.ok(
      document.stops.some((stop) => stop.message.includes('setup-basic-memory')),
    );
  });

  test('test_memory_enabled_with_missing_generated_routing_plans_setup', () => {
    enableMemory('missing');
    const document = plan();
    assert.equal(document.status, 'ready');
    const setup = document.follow_ups.find((entry) =>
      entry.commands[0].includes('setup_memory'),
    );
    assert.ok(setup, 'expected a setup_memory follow-up');
    assert.ok(
      document.notes.some(
        (note) => note.includes('missing') && note.includes('regenerates'),
      ),
    );
  });

  test('test_memory_enabled_with_stale_generated_routing_plans_setup', () => {
    enableMemory('stale');
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.ok(
      document.notes.some(
        (note) => note.includes('stale') && note.includes('regenerates'),
      ),
    );
  });

  test('test_memory_enabled_with_v050_connection_routing_plans_setup', () => {
    enableMemory('python-era', ['claude', 'codex']);
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.ok(
      document.notes.some(
        (note) => note.includes('stale') && note.includes('regenerates'),
      ),
    );
    assert.ok(
      !stopCodes(document).includes('memory-instructions-customized'),
    );
  });

  test('test_memory_enabled_with_edited_v050_connection_routing_stops', () => {
    enableMemory('python-era', ['claude', 'codex']);
    const instructions = join(
      ctx.project,
      '.agents/memory/config.md',
    );
    writeText(
      instructions,
      readFileSync(instructions, 'utf8') + 'Consumer note.\n',
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(
      stopCodes(document).includes('memory-instructions-customized'),
    );
    assert.ok(
      !document.follow_ups.some((entry) =>
        entry.commands[0].includes('setup_memory'),
      ),
    );
  });

  test('test_memory_enabled_with_invalid_routing_stops', () => {
    writeCapabilities('enabled');
    writeText(
      join(ctx.project, '.agents/memory/config.toml'),
      'schema_version = 1\n',
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(stopCodes(document).includes('memory-routing-invalid'));
    assert.ok(
      document.stops.some((stop) =>
        stop.message.includes('do not invent routing'),
      ),
    );
  });

  test('test_memory_enabled_with_customized_routing_stops', () => {
    enableMemory('customized');
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(
      stopCodes(document).includes('memory-instructions-customized'),
    );
    assert.ok(
      !document.follow_ups.some((entry) =>
        entry.commands[0].includes('setup_memory'),
      ),
    );
  });

  test('test_memory_enabled_at_a_wrong_library_path_stops', () => {
    enableMemory();
    gitOk(ctx.project, 'mv', '.agent-workflows', 'toolkit');
    ctx.source = join(ctx.project, 'toolkit');
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(stopCodes(document).includes('memory-path'));
  });

  test('test_missing_capabilities_is_a_question_not_a_stop', () => {
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.ok(questionCodes(document).includes('memory-choice'));
    assert.equal(decision(document, '--memory').applies, false);
    assert.ok(
      decision(document, '--memory').reason.includes('no choice is recorded'),
    );
  });

  test('test_t3_cutover_migration_commands', () => {
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ pythonEraOld: true, pinAt: 'base' });
    writeT3Config({ routing_source: null });
    const document = plan(ctx.pin);
    assert.equal(document.status, 'ready');
    const cutover = document.follow_ups.find((entry) =>
      entry.commands.some((command) => command.includes('--configure-action')),
    );
    assert.ok(cutover, 'expected a T3 cutover follow-up');
    assert.deepEqual(
      cutover.commands.map((command) => command.split(' ').pop()),
      ['--check', '--configure-action', '--check'],
    );
    assert.equal(cutover.when, 'after the owner commits the pin');
    assert.ok(
      document.notes.some((note) => note.includes('.agent-workflows-t3.py')),
    );
  });

  test('test_t3_cutover_reason_names_the_first_check_diagnostics', () => {
    // The .mjs launcher is already generated while the managed action
    // still points at Python: the first --check reports a
    // "Generated asset missing: <asset>; run --configure-action"
    // diagnostic — t3.json, and in other states
    // .agent-workflows-t3.mjs — not the stale-launcher migration
    // error. The reason states the pattern and names both assets so
    // any expected failure continues to --configure-action.
    writeT3Config({ routing_source: null });
    writeText(
      join(ctx.project, '.agent-workflows-t3.mjs'),
      '// generated launcher\n',
    );
    writeText(
      join(ctx.project, 't3.json'),
      JSON.stringify({
        scripts: [
          {
            id: 'agent-workflows-checkout-readiness',
            name: 'Agent workflows checkout readiness',
            command: 'python3 .agent-workflows-t3.py',
            icon: 'configure',
            runOnWorktreeCreate: true,
            runOnSettle: false,
            async: false,
          },
        ],
      }) + '\n',
    );
    const document = plan();
    assert.equal(document.status, 'ready');
    const cutover = document.follow_ups.find((entry) =>
      entry.commands.some((command) =>
        command.includes('--configure-action'),
      ),
    );
    assert.ok(cutover, 'expected a T3 cutover follow-up');
    assert.ok(
      cutover.reason.includes(
        'Generated bootstrap .agent-workflows-t3.py needs migration' +
          ' to .agent-workflows-t3.mjs',
      ),
      cutover.reason,
    );
    assert.ok(
      cutover.reason.includes(
        'Generated asset missing: <asset>; run --configure-action',
      ),
      cutover.reason,
    );
    assert.ok(
      cutover.reason.includes('t3.json') &&
        cutover.reason.includes('.agent-workflows-t3.mjs'),
      cutover.reason,
    );
  });

  test('test_t3_cutover_follows_the_memory_refresh', () => {
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ pythonEraOld: true, pinAt: 'base' });
    writeT3Config({ routing_source: null });
    enableMemory();
    const kinds = plan(ctx.pin).follow_ups.map((entry) =>
      entry.commands[0].includes('--configure-action') ||
      entry.commands[0].endsWith('t3_readiness --project . --check')
        ? 'cutover'
        : entry.commands[0].split(' ')[2],
    );
    assert.ok(kinds.indexOf('setup_memory') >= 0, kinds.join(','));
    assert.ok(kinds.indexOf('setup_memory') < kinds.indexOf('cutover'));
  });

  test('test_t3_python_action_alone_triggers_the_cutover', () => {
    writeT3Config({ routing_source: null });
    writeText(
      join(ctx.project, 't3.json'),
      JSON.stringify({
        scripts: [
          {
            id: 'agent-workflows-checkout-readiness',
            name: 'Agent workflows checkout readiness',
            command: 'python3 .agent-workflows-t3.py',
            icon: 'configure',
            runOnWorktreeCreate: true,
            runOnSettle: false,
            async: false,
          },
        ],
      }) + '\n',
    );
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.ok(
      document.follow_ups.some((entry) =>
        entry.commands.some((command) =>
          command.includes('--configure-action'),
        ),
      ),
    );
  });

  test('test_t3_python_command_outside_the_managed_action_is_a_note', () => {
    writeT3Config({ routing_source: null });
    // Same launcher command but not the exact managed action: the
    // cutover migrates only the managed action, so this is a note.
    writeText(
      join(ctx.project, 't3.json'),
      JSON.stringify({
        scripts: [
          {
            id: 'custom-readiness',
            name: 'Custom readiness',
            command: 'python3 .agent-workflows-t3.py',
          },
        ],
      }) + '\n',
    );
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.ok(
      !document.follow_ups.some((entry) =>
        entry.commands.some((command) =>
          command.includes('--configure-action'),
        ),
      ),
    );
    assert.ok(
      document.notes.some(
        (note) =>
          note.includes('custom-readiness') &&
          note.includes('python3 .agent-workflows-t3.py'),
      ),
      document.notes.join('\n'),
    );
  });

  test('test_t3_choice_is_reported_in_the_plan', () => {
    const none = plan();
    assert.equal(none.t3.choice, null);
    assert.match(updatePlan.renderText(none), /t3: no recorded choice/);
    writeT3Config({ routing_source: null });
    const enabled = plan();
    assert.equal(enabled.t3.choice, 'enabled');
    assert.match(updatePlan.renderText(enabled), /t3: enabled/);
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture();
    writeT3Config({ routing_source: null }, 'declined');
    const declined = plan();
    assert.equal(declined.t3.choice, 'declined');
    assert.match(updatePlan.renderText(declined), /t3: declined/);
  });

  test('test_t3_enabled_and_memory_enabled_adds_routing_source_check', () => {
    enableMemory();
    writeT3Config({
      enabled: true,
      routing_source: '.agents/memory-routing.md',
    });
    const document = plan();
    assert.equal(document.status, 'ready');
    const routing = document.follow_ups.find((entry) =>
      entry.commands[0].includes('--check-routing-source'),
    );
    assert.ok(routing, 'expected a routing-source follow-up');
    assert.equal(routing.when, 'after the owner commits the pin');
    const kinds = followUpKinds(document);
    assert.deepEqual(kinds, [
      'setup_memory',
      't3_readiness',
      'memory_preflight',
    ]);
  });

  test('test_unparseable_t3_config_stops', () => {
    writeText(join(ctx.project, '.agent-workflows-t3.json'), 'not json\n');
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(stopCodes(document).includes('t3-config'));
  });
});

// -- Helper-refusal preflights --------------------------------------------------------

describe('HelperRefusalTests', () => {
  beforeEach(() => {
    buildFixture();
  });

  afterEach(() => {
    rmSync(ctx.tmp, { recursive: true, force: true });
  });

  test('test_ignored_worktree_file_at_a_target_tracked_path_stops', () => {
    // The target starts tracking a path the library ignores; a plain
    // checkout would silently overwrite the ignored owner file. The
    // adoption carries --no-overwrite-ignore, and the plan stops naming
    // the file before anyone runs it.
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ ignoredTarget: true });
    writeText(join(ctx.source, 'generated.txt'), 'owner content\n');
    const document = plan(ctx.target);
    assert.equal(document.status, 'stop');
    const stop = document.stops.find(
      (entry) => entry.code === 'ignored-collision',
    );
    assert.ok(stop, stopCodes(document).join(','));
    assert.ok(stop.message.includes('generated.txt'), stop.message);
    assert.ok(
      stop.message.includes('preserve or move these owner files'),
      stop.message,
    );
    const adoption = document.follow_ups[0];
    assert.ok(adoption);
    assert.equal(
      adoption.commands[0],
      'git -C .agent-workflows checkout --no-overwrite-ignore' +
        ` --detach ${ctx.target}`,
    );
    // The plan is read-only: the ignored file is untouched.
    assert.equal(
      readFileSync(join(ctx.source, 'generated.txt'), 'utf8'),
      'owner content\n',
    );
  });

  test('test_target_changed_reference_set_stops_policy_review', () => {
    // The reviewer's reproduction: the consumer's AGENTS.md carries the
    // generated reference-only pointer for the pin's set; the target
    // adds another reference-only skill, so install would refuse the
    // stale generated block as customized.
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ referenceSkill: true, targetReferenceSkill: true });
    writeText(
      join(ctx.project, 'AGENTS.md'),
      '# Consumer rules\n\n' +
        install.COLLAB_BLOCK +
        '\n\n' +
        install.reference_block(ctx.source, ctx.project, ['local-note']) +
        '\n',
    );
    const pinned = plan();
    assert.equal(pinned.status, 'ready');
    const document = plan(ctx.target);
    assert.equal(document.status, 'stop');
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'policy-review' &&
          stop.message.includes('reference-only pointer'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_customized_legacy_worktree_block_stops_policy_review', () => {
    writeText(
      join(ctx.project, 'AGENTS.md'),
      '# Consumer rules\n\n' +
        install.START +
        '\nowner-edited policy\n' +
        install.END +
        '\n',
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'policy-review' &&
          stop.message.includes('legacy worktree'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_customized_collaboration_block_stops_policy_review', () => {
    writeText(
      join(ctx.project, 'AGENTS.md'),
      '# Consumer rules\n\n' +
        install.COLLAB_START +
        '\nowner-edited\n' +
        install.COLLAB_END +
        '\n',
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'policy-review' &&
          stop.message.includes('collaboration policy'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_missing_policy_blocks_are_listed_as_an_edit', () => {
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.deepEqual(document.install.edits, [
      { path: 'AGENTS.md', change: 'update managed policy blocks' },
    ]);
    assert.match(
      updatePlan.renderText(document),
      /edit: AGENTS\.md — update managed policy blocks/,
    );
  });

  test('test_memory_local_skill_override_stops_memory_review', () => {
    enableMemory();
    writeText(
      join(ctx.project, '.agents/skills/setup-basic-memory/SKILL.md'),
      '---\nname: setup-basic-memory\ndescription: local.\n---\n# local\n',
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'memory-review' &&
          stop.message.includes('Local skill override'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
    assert.ok(
      !document.follow_ups.some((entry) =>
        entry.commands[0].includes('setup_memory'),
      ),
    );
  });

  test('test_memory_conflicting_skill_link_stops_memory_review', () => {
    enableMemory();
    mkdirSync(join(ctx.project, '.agents/skills'), { recursive: true });
    symlinkSync(
      '../../.agent-workflows/.agents/skills/shape-issue',
      join(ctx.project, '.agents/skills/setup-basic-memory'),
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'memory-review' &&
          stop.message.includes('Conflicting memory skill link'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_memory_claude_skill_override_stops_memory_review', () => {
    enableMemory();
    mkdirSync(join(ctx.project, '.claude/skills'), { recursive: true });
    symlinkSync(
      '../../.agent-workflows/.agents/skills/shape-issue',
      join(ctx.project, '.claude/skills/shape-issue'),
    );
    writeText(
      join(ctx.project, '.claude/skills/setup-basic-memory/SKILL.md'),
      '---\nname: setup-basic-memory\ndescription: local.\n---\n# local\n',
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(document.install.flags.includes('--claude-skills'));
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'memory-review' &&
          stop.message.includes('.claude/skills/setup-basic-memory'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_memory_block_needing_migration_stops_memory_review', () => {
    enableMemory();
    writeText(
      join(ctx.project, 'AGENTS.md'),
      '# Consumer rules\n\n' +
        setupMemory.START +
        '\nowner-edited memory policy\n' +
        setupMemory.END +
        '\n',
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'memory-review' &&
          stop.message.includes('memory policy block'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_memory_lifecycle_instructions_stop_memory_review', () => {
    enableMemory();
    writeText(
      join(ctx.project, 'AGENTS.md'),
      '# Consumer rules\n\nSee workflow-memory-milestone for history.\n',
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'memory-review' &&
          stop.message.includes('Retire old lifecycle instructions'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_memory_legacy_capture_hook_stops_memory_review', () => {
    // setup()'s own preflight refuses a retired memory_lifecycle.py
    // capture hook — the plan reports the helper's message verbatim and
    // schedules no setup follow-up.
    enableMemory();
    writeText(
      join(ctx.project, '.codex/hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command:
                    'python3 .agent-workflows/scripts/memory_lifecycle.py',
                },
              ],
            },
          ],
        },
      }) + '\n',
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'memory-review' &&
          stop.message.includes('Retire the old custom capture hook'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
    assert.ok(
      !document.follow_ups.some((entry) =>
        entry.commands[0].includes('setup_memory'),
      ),
    );
  });

  test('test_memory_invalid_connection_profile_stops_memory_review', () => {
    // An existing but invalid machine profile — here a non-HTTP(S)
    // endpoint — is setup()'s refusal, not an owner question: the plan
    // stops memory-review with the helper's message.
    const xdg = join(ctx.tmp, 'xdg');
    writeText(
      join(xdg, 'agent-workflows', 'memory-connection.toml'),
      'schema_version = 1\nendpoint = "ftp://memory.example.invalid"\n',
    );
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      enableMemory('current', ['codex']);
      const document = plan();
      assert.equal(document.status, 'stop');
      assert.ok(
        document.stops.some(
          (stop) =>
            stop.code === 'memory-review' &&
            stop.message.includes('Invalid machine connection profile') &&
            stop.message.includes('http(s) URL'),
        ),
        document.stops.map((stop) => stop.message).join('\n'),
      );
      assert.ok(
        !questionCodes(document).includes('memory-connection-profile'),
      );
      assert.ok(
        !document.follow_ups.some((entry) =>
          entry.commands[0].includes('setup_memory'),
        ),
      );
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  test('test_malformed_library_lock_is_an_inspection_error', () => {
    // A malformed skills-lock.json committed at the pin is a ValueError
    // install would raise — the plan reports it as the structured
    // inspection-error stop, never a silent ready.
    writeText(join(ctx.upstream, 'skills-lock.json'), 'not json\n');
    gitOk(ctx.upstream, 'add', 'skills-lock.json');
    commit(ctx.upstream, 'broken lock');
    const broken = gitOk(ctx.upstream, 'rev-parse', 'HEAD');
    gitOk(ctx.source, 'fetch', '-q', 'origin');
    gitOk(ctx.source, 'checkout', '-q', '--detach', broken);
    gitOk(ctx.project, 'add', '.agent-workflows');
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.deepEqual(stopCodes(document), ['inspection-error']);
    assert.ok(
      document.stops[0].message.includes('skills-lock.json'),
      document.stops[0].message,
    );
  });

  test('test_claude_import_edit_is_listed_for_review', () => {
    mkdirSync(join(ctx.project, '.claude/skills'), { recursive: true });
    symlinkSync(
      '../../.agent-workflows/.agents/skills/shape-issue',
      join(ctx.project, '.claude/skills/shape-issue'),
    );
    writeText(join(ctx.project, 'CLAUDE.md'), '# Claude rules\n');
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.ok(
      document.install.edits.some(
        (edit) =>
          edit.path === 'CLAUDE.md' &&
          edit.change === 'add @AGENTS.md import',
      ),
    );
    assert.match(
      updatePlan.renderText(document),
      /edit: CLAUDE\.md — add @AGENTS\.md import/,
    );
  });

  test('test_claude_import_already_present_records_no_edit', () => {
    mkdirSync(join(ctx.project, '.claude/skills'), { recursive: true });
    symlinkSync(
      '../../.agent-workflows/.agents/skills/shape-issue',
      join(ctx.project, '.claude/skills/shape-issue'),
    );
    writeText(join(ctx.project, 'CLAUDE.md'), '# Claude rules\n@AGENTS.md\n');
    const document = plan();
    assert.equal(document.status, 'ready');
    assert.ok(
      !document.install.edits.some((edit) => edit.path === 'CLAUDE.md'),
    );
  });

  test('test_target_without_update_plan_notes_the_old_procedure', () => {
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ predatesPlanner: 'script' });
    const document = plan(ctx.target);
    assert.equal(document.status, 'ready');
    assert.equal(document.pins.new, ctx.target);
    assert.ok(
      !document.notes.some((note) => note.includes('rerun `update plan`')),
    );
    const note = document.notes.find((entry) =>
      entry.includes('predates `update plan`'),
    );
    assert.ok(note, document.notes.join('\n'));
    assert.ok(
      note.includes(
        'git -C .agent-workflows show ' +
          `${ctx.target}:.agents/skills/update-agent-workflows/SKILL.md`,
      ),
      note,
    );
    assert.ok(note.includes("current revision's view"), note);
  });

  test('test_target_without_update_registration_notes_the_old_procedure', () => {
    rmSync(ctx.tmp, { recursive: true, force: true });
    buildFixture({ predatesPlanner: 'registration' });
    const document = plan(ctx.target);
    assert.equal(document.status, 'ready');
    assert.ok(
      !document.notes.some((note) => note.includes('rerun `update plan`')),
    );
    assert.ok(
      document.notes.some((note) =>
        note.includes('predates `update plan`'),
      ),
    );
  });

  test('test_live_link_at_a_retired_name_is_a_stale_link_stop', () => {
    // A live link under a retired name into the library is not
    // install's to retire — only a broken link resolving to the retired
    // path is — so it faces the same review as any stale link.
    mkdirSync(join(ctx.project, '.agents/skills'), { recursive: true });
    symlinkSync(
      '../../.agent-workflows/.agents/skills/shape-issue',
      join(ctx.project, '.agents/skills/memory-notes'),
    );
    const document = plan();
    assert.equal(document.status, 'stop');
    assert.ok(
      document.stops.some(
        (stop) =>
          stop.code === 'link-conflict' &&
          stop.message.includes('memory-notes'),
      ),
      document.stops.map((stop) => stop.message).join('\n'),
    );
  });

  test('test_broken_link_at_a_retired_name_stays_exempt', () => {
    mkdirSync(join(ctx.project, '.agents/skills'), { recursive: true });
    symlinkSync(
      '../../.agent-workflows/.agents/skills/memory-notes',
      join(ctx.project, '.agents/skills/memory-notes'),
    );
    const document = plan();
    assert.equal(document.status, 'ready');
  });
});

// -- Dispatcher wiring -------------------------------------------------------------

describe('DispatcherTests', () => {
  afterEach(() => {
    if (ctx.tmp) rmSync(ctx.tmp, { recursive: true, force: true });
    ctx.tmp = '';
  });

  test('test_update_without_a_subcommand_is_a_usage_error', () => {
    const missing = runDispatcher(DISPATCHER, ['update']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /usage: agent-workflows\.ts update/);
    const unknown = runDispatcher(DISPATCHER, ['update', 'bogus']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown subcommand 'bogus'/);
  });

  test('test_update_plan_json_is_the_plan_document_not_the_envelope', () => {
    buildFixture();
    // The real dispatcher's library root is this repository, which is not
    // pinned inside the fixture consumer — the plan is a stop document,
    // still exactly one JSON document with no envelope keys.
    const result = runDispatcher(DISPATCHER, [
      'update', 'plan', '--project', ctx.project, '--json',
    ]);
    assert.equal(result.status, 3);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(parsed['status'], 'stop');
    assert.ok(!('ok' in parsed) && !('stdout' in parsed));
    assert.ok(
      (parsed['stops'] as { code: string }[]).some(
        (stop) => stop.code === 'not-pinned',
      ),
    );
    assert.ok(result.stdout.endsWith('}\n'));
  });

  test('test_update_plan_usage_errors_exit_2', () => {
    const result = runDispatcher(DISPATCHER, [
      'update', 'plan', '--bogus',
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unrecognized arguments: --bogus/);
    const missingValue = runDispatcher(DISPATCHER, [
      'update', 'plan', '--project',
    ]);
    assert.equal(missingValue.status, 2);
  });

  test('test_update_plan_option_like_values_are_usage_errors', () => {
    // `--target --json` must not swallow `--json` as the target value;
    // argparse refuses an option-like token where a value is expected.
    for (const args of [
      ['update', 'plan', '--target', '--json'],
      ['update', 'plan', '--project', '--json'],
      ['update', 'plan', '--target', '-h'],
    ]) {
      const result = runDispatcher(DISPATCHER, args);
      assert.equal(result.status, 2, args.join(' '));
      assert.match(result.stderr, /expected one argument/);
    }
  });

  test('test_pinned_dispatcher_runs_a_ready_plan', () => {
    buildFixture({ dispatcher: true });
    const dispatcher = join(
      ctx.source,
      'bin/agent-workflows.ts',
    );
    assert.ok(isFile(dispatcher));
    const result = runDispatcher(
      dispatcher,
      ['update', 'plan', '--project', '.', '--json'],
      ctx.project,
    );
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(parsed['status'], 'ready');
    assert.equal(
      (parsed['library'] as Record<string, unknown>)['state'],
      'at-pin',
    );
    // Human output renders the same plan.
    const human = runDispatcher(
      dispatcher,
      ['update', 'plan', '--project', '.'],
      ctx.project,
    );
    assert.equal(human.status, 0);
    assert.match(human.stdout, /status: ready/);
    assert.match(human.stdout, /state at-pin/);
    // A dirty library stops with exit 3 through the same entry point.
    writeText(join(ctx.source, 'dirty.txt'), 'x\n');
    const dirty = runDispatcher(
      dispatcher,
      ['update', 'plan', '--project', '.'],
      ctx.project,
    );
    assert.equal(dirty.status, 3);
    assert.match(dirty.stdout, /stop \[dirty\]/);
    unlinkSync(join(ctx.source, 'dirty.txt'));
  });

  test('test_pinned_dispatcher_self_referential_link_exits_3', () => {
    // A symlink loop at a managed destination is a printed stop plan —
    // never exit 1 with empty stdout.
    buildFixture({ dispatcher: true });
    const dispatcher = join(
      ctx.source,
      'bin/agent-workflows.ts',
    );
    mkdirSync(join(ctx.project, '.agents/skills'), { recursive: true });
    symlinkSync(
      'review-issue',
      join(ctx.project, '.agents/skills/review-issue'),
    );
    const result = runDispatcher(
      dispatcher,
      ['update', 'plan', '--project', '.'],
      ctx.project,
    );
    assert.equal(result.status, 3);
    assert.match(result.stdout, /stop \[link-conflict\]/);
    assert.match(result.stdout, /Unresolvable symlink/);
  });
});
