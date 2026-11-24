# TypeScript port

This document records the design of the TypeScript foundation landed for
issue #111, the conventions TypeScript modules follow, and the parity
checks that keep the port honest while Python remains the shipped tooling.

## Why this exists

The maintainer works in TypeScript, so a TypeScript codebase is easier to
review and debug. The tool's audience already has Node installed: Claude
Code, Codex and OpenCode are all installed through npm. Today they need
Python 3.11+ as well. Changing how the scripts are run after going public
would force early adopters to migrate, so this work lands before the
public baseline rebuild.

Milestone 2 replaces the Python tooling with TypeScript modules reachable
through a single dispatcher — `node .agent-workflows/bin/agent-workflows.ts
<command>` — implemented as several bounded issues. Issue #111 lays the
foundation only: the toolchain, shared helpers, a parity harness, and one
pilot module. It changes no consumer-facing command.

**The cutover has landed (issue #118).** The shipped interface is now
`bin/agent-workflows.ts` under Node 22.18+; Python tooling has been
removed. During the port, parity against the Python originals was the
definition of done: stdout, exit codes, stderr where applicable, and
written files all matched, with only the
[allowed differences](#allowed-differences) below — that contract is the
record the cutover met. See
[typescript-cutover.md](typescript-cutover.md) for consumer migration.

## Conventions

- **Same distribution model.** Consumers keep using the pinned checkout;
  the TypeScript files are plain source, committed next to the Python
  originals. There is no consumer-side `npm install`, no build step and
  no emitted JavaScript in the repository.
- **Direct execution.** Node 22.18+ runs the `.ts` files directly through
  built-in type stripping. The minimum runtime is recorded in
  [`package.json`](../package.json) (`engines.node >=22.18`); CI verifies
  on exactly 22.18.
- **Erasable syntax only.** TypeScript syntax must be erasable so type
  stripping works without a transpiler: no `enum`, `namespace`, parameter
  properties or other constructs Node cannot strip. `tsconfig.json` sets
  `erasableSyntaxOnly`, `strict`, `noEmit` and
  `allowImportingTsExtensions`; `npx tsc --noEmit` is the type check.
- **Explicit `.ts` imports.** Internal imports name the `.ts` file
  (`import { load } from './mcp_requirements.ts'`) as required by
  `allowImportingTsExtensions`. A future npm executable may compile the
  same sources to JavaScript with the imports rewritten to `.js`, so code
  must not depend on running as TypeScript beyond syntax stripping.
- **Library root from `import.meta.url`.** Modules resolve their own
  root (for vendored assets and sibling files) from `import.meta.url`,
  never from the process working directory — the dispatcher runs inside
  consumer checkouts.
- **Dev-only dependencies.** `package.json` is private, has no
  `dependencies` section and pins `typescript`, `ajv`, `yaml` and
  `@types/node` as `devDependencies` for checking and tests. Vendored
  code covers runtime needs.
- **No Python runtime additions.** `requirements-dev.txt` is unchanged;
  TOML is read by the vendored parser, not a Python package.

## Shared helpers

[`scripts/lib/`](../scripts/lib/) carries the Python-semantics
foundations every ported module builds on:

- [`pyjson.ts`](../scripts/lib/pyjson.ts) — `pyJson` reproduces
  `json.dumps(value, ensure_ascii=True, sort_keys=True)` byte-for-byte in
  both modes the scripts use: compact `separators=(",", ":")` and
  `indent=2` `separators=(",", ": ")`, including non-ASCII escaping,
  float repr and non-finite values.
- [`atomic.ts`](../scripts/lib/atomic.ts) — `atomicWrite` mirrors
  `memory_connections.atomic`: create parent directories, `mkstemp`-style
  temporary file in the destination directory, write text, atomic
  rename, and unlink the temp file if it remains.
- [`git.ts`](../scripts/lib/git.ts) — `runGit` mirrors the scripts'
  `subprocess.run(["git", "-C", root, *args], capture_output=True,
  text=True)` over `child_process.spawnSync`, returning Python-style
  `status`/`stdout`/`stderr`.
- [`pyerrors.ts`](../scripts/lib/pyerrors.ts) and
  [`pyrepr.ts`](../scripts/lib/pyrepr.ts) — Python-style error classes
  (`ValueError`, `KeyError`, `AttributeError`, `TypeError`-style) and
  `repr`/`str` formatting helpers, so structured-error output and
  diagnostic wording match the originals.
- [`pyloads.ts`](../scripts/lib/pyloads.ts) — `pyJsonLoads` parses with
  CPython 3.12 `json.loads` semantics, `parse_constant` non-finite tokens
  and the `str` BOM rejection included; `jsonLoadsError` reproduces the
  `JSONDecodeError` it raises (`msg`, code-point `pos`) and
  `jsonLoadsErrorMessage` formats `str(error)` (`{msg}: line {n}
  column {n} (char {n})`), so decode failures embedded in diagnostics match
  the originals byte-for-byte.
- [`pyio.ts`](../scripts/lib/pyio.ts) — `readText` mirrors
  `Path.read_text()`: UTF-8 decoding with universal newlines, the
  byte-order mark left in the text, and Python error classes
  (`UnicodeDecodeError`, the `OSError` subclasses) on failure.

## Vendored TOML parser

TOML is parsed by [smol-toml](https://github.com/squirrelchat/smol-toml)
**1.9.1** (BSD-3-Clause), vendored under
[`scripts/vendor/smol-toml/`](../scripts/vendor/smol-toml/) with its
licence and [`PROVENANCE.md`](../scripts/vendor/smol-toml/PROVENANCE.md)
recording the npm tarball SHA-256 and the upstream source commit
(`69aa050fef018b71799519bb2cbb54f158a0c5f9`, tag `v1.9.1`). It has no
runtime dependencies.

Parity contract: smol-toml must accept every TOML document Python 3.12
`tomllib` accepts and reject everything it rejects. `node --test` runs
`tests/test_toml_parity.test.ts`,
which parses every committed TOML file — `.codex/agents/*.toml`, the docs
examples, the mcp-configure fixtures — plus the explicit reject fixtures
in [`tests/fixtures/toml/`](../tests/fixtures/toml/) (duplicate keys,
duplicate tables, invalid dates/escapes, missing values, unclosed
tables/arrays) with both parsers and compares verdicts and normalized
values (integers, floats, dates, datetimes, special float values).

## Pilot module: mcp_requirements

[`scripts/mcp_requirements.ts`](../scripts/mcp_requirements.ts) ports
`scripts/mcp_requirements.py` with the
same validation semantics and diagnostic wording. Python idioms that
JavaScript does not share — dict/list/string membership, iteration over
objects and strings, `.get()` on non-dicts, missing-key errors and
`repr` formatting — are reproduced through the `scripts/lib` helpers so
observable behaviour matches, including error classes in the structured
parity output.

Because `mcp_requirements.py` has no command-line interface, green parity
for this slice is proven by a test-only driver, not a product feature:
`tests/parity/mcp-requirements-cases.json`
lists 161 cases (manifest loading, diagnostics, readiness, unmet
prerequisites, applicability, regex decisions) built from the same
tables the Python tests use, plus cases for the review findings
(non-finite tokens, CRLF offsets, UTF-8 BOM, int/float materialization,
integer-like key order, positive float zero and set membership by
value, JSON non-finite singletons, deep container equality and explicit
null machine fields);
`mcp_requirements_driver.py`
and `mcp_requirements_driver.ts`
evaluate every case and emit canonical JSON. The two outputs are
byte-identical.

## Parity harness

`tests/parity/harness.ts` ran a Python
command and its TypeScript counterpart against identical disposable
copies of a fixture consumer
(`tests/fixtures/parity/consumer/`)
and compared, with a readable diff on any mismatch:

- exit code (signals map to negative codes consistently);
- stdout;
- stderr, normalized only for the allowed differences below;
- the byte contents of the entire written file tree, sorted
  deterministically;
- temporary consumer and repository paths normalized to stable
  placeholders before comparison.

For this issue the compared "command" is the mcp_requirements
function-level driver described above. Later issues registered real
command pairs in the same harness.

The parity harness ran during the port with
`AW_PARITY_PYTHON="uv run --python 3.12 python"` selecting the CPython
3.12 reference; it was deleted after the cutover once the final green
run was recorded. Nothing in the Node suite imports it, so the orphaned
driver-only pieces went with it: `mcp_requirements_driver.ts`,
`memory_connections_check_driver.ts`,
`memory_connections_render_driver.ts`, `t3_bootstrap_driver.ts`, the
`mcp-requirements`, `memory-connections-check` and
`memory-connections-render` case lists, and the
`tests/fixtures/parity/consumer/` fixture are removed.
`tests/parity/toml_diagnostic.ts` stays because
`tests/test_toml_diagnostic.test.ts` imports it. Current checks run on
Node 22.18 after `npm ci`:

```sh
npx tsc --noEmit
node --test
node scripts/validate.ts
```

## memory_connections (issue #113)

[`scripts/memory_connections.ts`](../scripts/memory_connections.ts) ports
`scripts/memory_connections.py`:
project-scope client connection artifacts (`.mcp.json`,
`.codex/config.toml`, `opencode.json`), the generated-ownership record
(`.agents/memory/connections.json`), git tracked/ignored state, and
check-only validation. The module also carries the private subset of
`mcp_configure` it calls — client inspection (`inspect_client`) and URL
equivalence (`equivalent_url`) — the full `mcp_configure` port is issue
#116, and `setup_memory`/`setup_memory_connections` orchestration is
issue #114.

Additions to `scripts/lib/`:

- [`pyurl.ts`](../scripts/lib/pyurl.ts) — `urllib.parse.urlsplit` with
  CPython semantics the WHATWG `URL` does not share: scheme-relative
  parsing, NFKC netloc validation, bracketed IPv4/IPv6/IPvFuture host
  validation via `ipaddress`-equivalent parsing, lazy `port` errors, and
  the `urlsplit(None)`/`urlsplit(non-string)` edge behaviour.

Module-level helpers beyond the shared library, needed for observable
parity:

- `parse_jsonc` ported verbatim (string-aware comment and trailing-comma
  stripping, then strict JSON), with dedicated rejection tests.
- `json.dumps` in the two shapes this module emits: `indent=2` with
  insertion order preserved (`jsonDumps`, for generated files and the
  ownership record) and `sort_keys=True` with Python's default
  `(', ', ': ')` separators (`jsonDumpsSorted`, embedded in the consumer
  alignment instructions — a mode `pyJson` does not cover).
- `tomllib` parsing goes through the vendored smol-toml; generated
  `.codex/config.toml` edits are appended text that is re-parsed to
  verify the result, and every TOML document this module reads or writes
  parses identically under both parsers (see the residual below).
  smol-toml accepts a few constructs `tomllib` rejects — trailing commas
  and raw newlines inside inline tables, `\e`/`\x` escapes, impossible
  calendar values, local times without seconds — so `tomlLoads`
  re-scans every accepted document and raises `ValueError` on them,
  giving this module's load path `tomllib`'s verdict.

### Test mapping (#113)

[`tests/test_memory_connections.test.ts`](../tests/test_memory_connections.test.ts)
mirrors the Python suite under `node:test`. The Python tests drive
`memory_connections` through `setup_memory.setup`/`run_connections`,
which #114 owns; the counterparts exercise the same module through a
local composition that reproduces exactly the calls `run_connections` and
`setup()` make into this module (read_state → connection_profile →
plan_connection_files → shadow/alignment preflight → render/check,
deselection leftovers, gitignore management for generated clients). Two
test-only seams mirror `mock.patch` usage: `setOpencodeEtcForTesting`
for the OpenCode `/etc` scope and `setAtomicForTesting` for atomic-write
injection.

Three Python tests have no counterpart, all for orchestration owned by
issue #114:

- `test_optin_upgrade_of_existing_routing_is_stale_not_customized` —
  asserts `setup()`'s 'Stale generated instructions' diagnostic, which
  compares `config.md` against the full `policy()`/`expected_instructions`
  text.
- `test_stale_or_customized_instructions_block_worktree_render` — asserts
  `connection_selection`'s customized/stale instruction gate, again built
  on the `#114` policy text.
- `test_unknown_and_duplicate_clients_are_rejected` — asserts
  `config_data`'s `connection.clients` validation (`clients` as
  non-array, unknown client names, duplicates), which lives in
  `setup_memory.py`, not `memory_connections.py`.

The remaining 52 methods keep their Python names; three added tests
(`test_parse_jsonc_*`) cover `parse_jsonc` acceptance and dedicated
rejection beyond the Python suite's incidental coverage.

### Parity drivers (#113)

`memory_connections` has no product CLI in this slice (the
`--project`/`--check`/`--profile` front end is `setup_memory_connections`,
#114). Parity therefore covers the module boundary the orchestration
calls, through two test-only driver pairs registered in
`tests/parity/harness.ts`:

- `memory_connections_render_driver.{py,ts}` +
  `memory-connections-render-cases.json` — 24 render-mode cases: full and
  idempotent renders, merge/appended-block preservation, JSONC shadowing,
  profile changes, tracked-file preservation, deselected leftovers,
  local-scope shadow refusal, missing ignore lines, legacy entry
  conflicts, missing/invalid profiles, untrusted-Codex warnings, manual
  entry conflicts, hand-edited generated entries, malformed ownership
  records, and the Codex configuration documents smol-toml accepts but
  `tomllib` rejects.
- `memory_connections_check_driver.{py,ts}` +
  `memory-connections-check-cases.json` — 36 cases covering every
  `--check` diagnostic path `check_connections` produces: clean state;
  missing file/entry; profile drift; modified-after-generation; local
  shadowing and same-endpoint duplicates; missing Codex trust; missing
  ignore lines; disabled approvals; consumer-owned aligned, drifted,
  missing, unknown-shape, equivalent-name, disabled and literal-credential
  registrations; legacy entries; deselected leftovers and unrecorded
  manual entries; missing profile; structural-only validation without a
  profile; malformed ownership records; routing-source drift; invalid
  profiles; `/etc` OpenCode shadowing; unparseable JSONC layers; the
  same tomllib-verdict Codex documents; and an OpenCode layer whose path
  contains `Invalid TOML document:` so that filename is not rewritten.

Both drivers run the identical scenario interpreter: each case resets the
consumer copy to a baseline, applies spec writes (files, `.gitignore`
lines, machine profile, fake-HOME configuration, `/etc` layers, git
tracking changes), then calls the `memory_connections` boundary
(`read_state` → `connection_profile` → `plan_connection_files` →
`render_connections`/`check_connections`) and emits a canonical JSON
envelope of rendered clients, warnings, or the structured error.

Two determinism mechanics worth recording:

- **Detached git metadata.** `git ls-files`/`check-ignore`/`cat-file`
  need a repository, but `.git` inside the compared tree carries volatile
  index stat data. The drivers set `GIT_DIR=<consumer>/.parity-git` and
  `GIT_WORK_TREE=<consumer>` so `git -C` works fully with no `.git` in
  the tree, then delete the git dir before exit.
- **Path sanitization.** Scenario files embedding the consumer path
  (Codex `[projects."<consumer>"]` trust records) cannot byte-match
  across the two copies, so the drivers rewrite `<consumer>` placeholders
  inside their own fixture directories (`.parity-home`, `.parity-etc`)
  before exit — the same normalization the harness applies to stdout.

### Residual: embedded TOML parser diagnostics

A few `ValueError` diagnostics embed the TOML parser's own message: an
unparseable machine profile (`Unreadable machine connection profile …:
<parse error>`) and the 'Cannot extend `<file>` … (<parse error>)'
refusal when an appended block fails re-parse. smol-toml's error wording and positions differ from
CPython `tomllib`'s and cannot be mapped, so the parity drivers
normalize the diagnostic tail before comparing; semantic rejections
(the messages above minus the parser tail) match byte-for-byte. That
wording gap is allowed difference
3 below. Acceptance and rejection verdicts, parsed values, and generated
document bytes still match.

## Allowed differences

Approved Python↔TypeScript divergences:

1. argparse usage and help text;
2. Python traceback wording;
3. TOML parser diagnostic text. smol-toml 1.9.1 must still accept every
   document CPython 3.12 `tomllib` accepts and reject every document it
   rejects, and parsed values must match except for item 5's
   datetime-precision allowance. The diagnostic wording and reported
   position may differ wherever the port embeds the parser's own
   message. smol-toml prints a short reason plus a multiline caret
   diagram. `tomllib` prints `TOMLDecodeError: … (at line N, column M)`.

   Confirmed on this machine:

   - `endpoint = \n` — tomllib: `TOMLDecodeError: Invalid value (at line 1, column 12)`. smol-toml: `Invalid TOML document: invalid value` plus a caret under the empty value.
   - `mcp_servers = { other = 1 }` followed by `[mcp_servers.basic_memory]` — tomllib: `TOMLDecodeError: Cannot declare ('mcp_servers', 'basic_memory') twice (at line 2, column 26)`. smol-toml: `Invalid TOML document: trying to redefine an already defined table or value` plus a caret under the table header.

   The parity harness may exclude those malformed documents, or compare
   them after normalizing only that diagnostic tail. Well-formed TOML,
   exit codes, stdout, and written files still match byte for byte. The
   same allowed difference covers later slices that embed this parser's
   diagnostic.
4. Plan `files` order. TypeScript emits one stable order, the order
   CPython produces at `PYTHONHASHSEED=0`. Parity for plan bytes and
   `sha256:` digests is measured at that seed. Python's hash-seed order
   is otherwise unchanged.
5. TOML datetime precision. Parsed datetimes may be truncated to
   milliseconds (`1979-05-27T07:32:00.123456Z` may become `.123`).
   Accept/reject behavior stays exact. This covers `tomlLoads` as well
   as `mcp_configure`.

Items 4 and 5 are the only further exceptions; everything else must
match. The mcp_requirements harness compares
structured JSON success/error envelopes rather than traceback text, so it
applies no normalization. The memory_connections drivers normalize only
that diagnostic tail — a span ending in `(at line N, column M)` — for
documents smol-toml accepts but `tomllib` rejects. Success text that
merely contains `Invalid TOML document:` stays unchanged. Documents both
parsers reject stay out of the drivers.

## Test mapping

`tests/test_mcp_requirements.test.ts` mirrors
`tests/test_mcp_requirements.py`
test-for-test under `node:test`; each test keeps its Python method name.
`test_schema_invalid_implies_python_invalid` becomes
`test_schema_invalid_implies_typescript_invalid`, and one additional
`test_applies` under `ReadinessTests` covers `applies()` decisions the
Python suite exercised inside readiness tests. Schema agreement uses
`ajv`'s Draft 2020 implementation matching `jsonschema`'s
`Draft202012Validator`; `EcmaRegexParityTests` checks every schema regex
against both `re` and `RegExp` through the configured Python.

| Python test class | TypeScript suite | Python tests | TS tests |
|---|---|---|---|
| `ManifestTests` | `ManifestTests` | 6 | 6 |
| `DiagnosticTests` | `DiagnosticTests` | 7 | 7 |
| `ReadinessTests` | `ReadinessTests` | 6 | 7 (adds `test_applies`) |
| `SchemaAgreementTests` | `SchemaAgreementTests` | 5 | 5 |
| `EcmaRegexParityTests` | `EcmaRegexParityTests` | 1 | 1 |

Helper coverage has no Python test counterpart to mirror and is verified
directly against Python 3.12 instead:
`test_pyjson.test.ts` (byte-identical
dumps, non-ASCII included),
`test_atomic.test.ts` and
`test_git.test.ts` (status/stdout/stderr).
Recorded before the Python removal: modules not yet ported at that
point (`memory_readiness`,
`mcp_configure`, `validate`, `deliver`, `check_agent_frontmatter`,
`check_versions`) kept their Python tests, and the Python suite ran
**446 tests** (observed with `python -m unittest discover -s tests` on
3.12; the issue's "401 tests" figure was stale). The TypeScript cutover
has since removed the Python sources and their suite (#118).

## Checks

The full verification set for TypeScript changes, on Node 22.18:

```sh
npm ci
npx tsc --noEmit
node --test
node scripts/validate.ts
```

CI runs all four in the `Validate workflows` job on Node 22.18:
[`.github/workflows/validate.yml`](../.github/workflows/validate.yml).
The pre-deletion parity run (`python -m unittest discover -s tests`,
`python scripts/validate.py`, `node tests/parity/harness.ts`) is
recorded in the pull request.

## Risks

- **JSON byte differences.** Manifest and report output must match
  Python `json.dumps` exactly — separators, `ensure_ascii` escapes,
  float repr, key ordering. `pyJson` centralizes this and is byte-verified
  against Python 3.12; any new serialization must go through it.
- **TOML editing and parser rejection.** TOML will eventually be edited,
  not just read. A parser that accepts what `tomllib` rejects (or vice
  versa) would break consumers under the Python↔TypeScript transition;
  the fixture set plus explicit reject cases guard the boundary. Editing
  semantics are deferred to the issue that needs them.
- **Strict JSONC.** Client configuration files (e.g. `.codex/config.toml`
  companions, VS Code settings) are JSONC-ish in the wild; the schema and
  Python treat them as strict JSON. Ports must not quietly become more
  permissive.
- **Consumer migration.** Consumer checkouts and docs moved from
  `python` script invocations to `node` at cutover; landing it before the
  public baseline minimized the migration forced on adopters.

## Install module (issue #112)

[`scripts/install.ts`](../scripts/install.ts) ports
`scripts/install.py` function-for-function:
install and `--check` modes, toolkit linking, retired-skill detection
with the recorded SHA-256 ownership hashes, `.agent-workflows-capabilities.json`
handling, `--codex-agents`, `--claude-skills` (including the `CLAUDE.md`
`@AGENTS.md` import and its Markdown-content rejection), delivery-profile
creation and preservation, worktree-policy block migration, and the
detached registered-submodule rules. The library root comes from
`import.meta.url` exactly like `Path(__file__).resolve().parents[1]` —
through a symlink-aware resolve so a library reached through a linked
path finds the same source root Python finds.

Two byte contracts called out in the issue:

- `write_capabilities` is
  `json.dumps({"schema_version": 1, "memory": choice}, indent=2) + "\n"`
  with `sort_keys=False`, so `schema_version` precedes `memory`. `pyJson`
  sorts keys; `install.ts` emits this file's fixed two-line shape
  directly rather than weakening the shared helper's sorted contract.
- `read_capabilities` embeds `str(JSONDecodeError)` inside its
  `ValueError`; `pyJsonLoads`/`jsonLoadsErrorMessage` reproduce that text.

The CLI is parsed by a small argparse-faithful front end instead of a
dependency: abbreviations, `=` forms, the `--skills` migration error,
required-argument and invalid-choice diagnostics all match. Help/usage
output happens to match argparse byte-for-byte on Python 3.12 anyway;
the only sanctioned divergence remains the allowed-differences list
above.

Path semantics matter here beyond `readText`: `pyResolve` mirrors
`Path.resolve()` (symlink-following, `..`-collapsing) so relative links,
ownership checks and submodule gitlinks resolve identically, and
`pyOsError`/`tryFs` translate `errno` failures into the Python exception
names and `str()` text diagnostics embed. `runGit` covers every
`subprocess.run(["git", "-C", ...])` call with the same argv, cwd and
text-mode newline translation.

### Test mapping: install

[`tests/test_install.test.ts`](../tests/test_install.test.ts) mirrors
`tests/test_install.py` test-for-test under
`node:test`, keeping the Python method names, plus the two install-bound
`DistributionTests` cases from
`tests/test_milestone_delivery.py`
(`test_deliver_milestone_is_an_installed_toolkit_skill`,
`test_deliver_milestone_frontmatter_is_installable`, which import
`scripts/install.py` and call `toolkit()`).

| Python test class | TypeScript suite | Python tests | TS tests |
|---|---|---|---|
| `InstallTests` | `InstallTests` | 80 | 80 |
| `SelfConsumptionTests` | `SelfConsumptionTests` | 8 | 8 |
| `SkillsMigrationTests` | `SkillsMigrationTests` | 4 | 4 |
| `DeliveryProfilesTests` | `DeliveryProfilesTests` | 5 | 5 |
| `PinnedSubmoduleTests` | `PinnedSubmoduleTests` | 13 | 13 |
| `DistributionTests` (from `test_milestone_delivery.py`) | `DistributionTests` | 2 | 2 |

`tests/test_delivery_guidance.py`
has no install counterpart to port: it never imports `install.py` or
runs an install — it reads the skill sources directly — so no
`node:test` case is recorded for it.

### Parity cases: install

The parity harness gained scenario support without changing its
comparison rules: `args` (literal argv entries with `{consumer}`
substituted, replacing the appended copy path), `env`, `prepare`
(deterministic pre-state built identically in both disposable copies;
baseline installs run the Python command itself), `treeIgnore`
(a relative-path pattern that prunes absolute Git internals, which are
unavoidably per-copy metadata), and `normalizeStderr` (an extra
per-case stderr normalization for an allowed difference, applied after
the path placeholders). Symlinks now compare by link text
instead of reading through to target bytes.

Registered install cases: `install-basic`, `install-memory-declined`,
`install-memory-enabled`, `install-codex-agents`, `install-claude-skills`,
`install-claude-import`, `install-delivery-profiles`, `install-all-flags`,
`install-legacy-block-migration`, `check-clean`, `check-missing-link`,
`check-missing-block`, `check-customized-block`, `check-legacy-block`,
`check-retired-entries`, `install-retired-entries`,
`check-same-name-preserved`, `check-stale-library-link`,
`check-memory-link-unexpected`, `install-local-dir-conflict`,
`check-claude-import-missing`, `check-capability-not-recorded`,
`check-capability-conflict`, `check-capability-unreadable`,
`check-capability-unrecognized`, `install-missing-agents`,
`check-profiles-missing`, `cli-skills-migration`,
`cli-skills-equals-migration`, `cli-unknown-arg`, `cli-invalid-memory`,
`cli-expected-argument`, `cli-ambiguous-option`,
`cli-ambiguous-option-explicit`, `cli-help-explicit-argument`,
`cli-help-explicit-repr`, `cli-check-explicit-repr`,
`cli-missing-project`,
`cli-help`, `self-install`, `self-check`, `self-codex-agents`,
`pinned-install-detaches`, `pinned-check-attached`,
`pinned-check-detached`, `pinned-dirty`, `pinned-different-pin`,
`pinned-ahead-of-pin`, `pinned-corrupt-index`, `unregistered-clone`,
`install-claude-import-symlink-loop`.

Pinned-submodule coverage uses a deterministic sibling `libsrc`
repository (fixed author/committer identity and dates) so recorded pins,
detached SHAs and `git submodule` metadata are byte-stable; `.git`
internals are the pruned tree paths. States that cannot be produced by a
real command line stay unit-test-only: an uninitialized submodule (the
script under test lives inside the deinitialized checkout), a nested
consumer worktree root, and the `linkHook`/`branch_error` seams —
`PinnedSubmoduleTests` covers those against the same fixtures.

### Review fixes: install parity hardening

An independent read-only review of the dirty #112 tree found five strict
parity gaps the registered cases missed. Each is fixed in TypeScript with
a regression that fails before the fix:

- **Absolute `CLAUDE.md` imports.** `path.parent / imported` keeps an
  absolute import instead of joining it under the parent directory;
  `prepare_claude_import` now mirrors that, so `@/absolute/...` is
  recognized instead of a second `@AGENTS.md` being appended. Parity
  case: `install-claude-import-absolute` — the file text is
  `@/proc/self/cwd/AGENTS.md`, one absolute string that resolves to each
  disposable copy's own contract because the spawned command's working
  directory is that copy.
- **Symlinked entry.** The CLI guard compares `import.meta.url` with the
  resolved `process.argv[1]` (`pyResolve`), so invoking `install.ts`
  through a symlink still runs `main()` like Python's `__main__` guard.
  Parity case: `cli-symlinked-entry`.
- **Boolean `schema_version`.** The `!= 1` comparisons now follow
  Python `==` (`True == 1`), covering both the capabilities file and
  adoption-manifest recognition. Parity cases:
  `check-capability-boolean-version`,
  `check-adopted-manifest-boolean-version`.
- **UTF-8 diagnostics.** `pyDecodeUtf8` in `pyio.ts` decodes strict
  UTF-8 and raises `UnicodeDecodeError` carrying CPython 3.12's codec
  wording (`'utf-8' codec can't decode byte 0xNN in position N:
  reason`); `readText` and the `CLAUDE.md` `read_bytes().decode` site
  share it, and `read_capabilities`/`third_party_skills` wrap only JSON
  decode failures like `except json.JSONDecodeError`, so a
  `UnicodeDecodeError` surfaces bare via `main`. Parity cases:
  `check-claude-import-undecodable`, `check-capability-undecodable`.
- **Typed tree comparison.** `fileTree` records each entry's kind
  (regular file vs symlink) with its bytes, so a link can no longer pass
  as a same-content file. Regressions live in `ParityHarnessTests`
  (`tests/test_install.test.ts`) — no Python counterpart, the harness is
  TypeScript-only — and the helpers are exported with `main()` guarded
  so test files can import them.

A second review pass found two more gaps, also fixed with a failing
regression first:

- **Symlink loops in `Path.resolve`.** `pyResolve` discarded the
  unresolved-loop marker from `joinRealpath`, matching
  `os.path.realpath(strict=False)` but not `Path.resolve(strict=False)`:
  CPython 3.12 stats the realpath result in non-strict mode and converts
  an `ELOOP` into `RuntimeError("Symlink loop from %r")`, which `main`
  does not catch — the CLI exits 1 after printing earlier stdout, with
  no consumer mutation. `pyResolve` now runs the same `stat()` check at
  every call site; other stat failures (missing paths included) stay
  ignored. Parity case: `install-claude-import-symlink-loop` — a
  self-referential `loop` symlink imported from `CLAUDE.md` by absolute
  path under `--claude-skills`. Only the traceback wording is normalized
  (`lastExceptionLine` reduces each side to its final exception line,
  the allowed "Python traceback wording" difference); exit code, stdout
  and the written tree compare exactly.
- **Explicit short-help arguments and ambiguous-option tokens.** The
  short-option branch fired help on any token whose second character
  was `h`, so `-h=foo` exited 0 where argparse exits 2 with
  `argument -h/--help: ignored explicit argument 'foo'`; and the
  ambiguous-option diagnostic printed the option name with the
  `=`-value stripped where argparse names the full token (`--c=x`).
  The short-option branch now mirrors `_parse_optional` /
  `consume_optional`: an exact `-h` or a tail re-read as more short
  options (a run of `h`s consumed, an unknown tail collected as an
  extra after queued help fires) still prints help, while a
  `=`-separated or `-`-leading remainder raises the
  ignored-explicit-argument error. Parity cases:
  `cli-help-explicit-argument`, `cli-ambiguous-option-explicit`.

A third review pass found that the long-option form of that same
diagnostic still wrapped the explicit value in literal single quotes.
argparse uses `repr`, which switches to double quotes when the value
contains an apostrophe and no double quote (`--help=it's` and
`--check=it's` print `"it's"`, not `'it's'`). Both long-option sites
now use `pyRepr`. Parity cases: `cli-help-explicit-repr`,
`cli-check-explicit-repr`.

## Adopt-skills module (issue #115)

[`scripts/adopt_skills.ts`](../scripts/adopt_skills.ts) ports
`scripts/adopt_skills.py`: hidden-folder
skill discovery, the SHA-256 `skill_signature`, the dry-run/`--apply`
plan, safe mutation (canonical copy before source removal, drift
backup/restore), and the `.agents/adopted-skills.json` provenance
manifest. `toolkit`, `link_status` and `make_relative_link` are imported
from [`install.ts`](../scripts/install.ts) exactly as the Python module
imports them from `install.py`.

Byte contracts called out in the issue:

- `write_manifest` is `json.dumps(manifest, indent=2) + "\n"` with
  `sort_keys=False`, so key insertion order is preserved. `pyJson` sorts
  keys; `adopt_skills.ts` emits the manifest through a small
  insertion-order serializer mirroring `pyJson`'s indent mode instead of
  weakening the shared helper's sorted contract (the same choice
  `install.ts` made for `write_capabilities`).
- The manifest accepts `"schema_version": true` because Python `True ==
  1`; the port uses the same `isOne` comparison `install.ts` applies in
  `read_capabilities`. Parity case: `adopt-manifest-boolean-version`.
- `redact_command` tokenizes with `shlex.split` semantics: an
  unparseable command records `<redacted: unparseable command>` rather
  than a partial redaction. Secret matching is `re.IGNORECASE`, which
  CPython extends with four extra equivalences — İ (U+0130) and
  ı (U+0131) for `i`, ſ (U+017F) for `s`, K (U+212A) for `k`; candidate
  tokens are normalized through those foldings before matching so
  exotic spellings redact identically.
- `skill_signature` hashes `rel.encode() + b"\0"` then each file's
  SHA-256 over relative paths sorted in Python code-point order, and
  symlinks/non-regular files are unsafe rather than hashed.

The CLI front end reuses the argparse-faithful conventions from
`install.ts`: long-option abbreviation, `=` forms, the mutual-exclusion
diagnostics for `--apply`/`--check` in both orders, `--` handling, the
`ignored explicit argument` and `expected one argument` errors, and
`repr` quoting of explicit values. Usage and help output embed the
Python 3.12 `HelpFormatter` bytes (wrapped at `COLUMNS=80`), so they
match byte-for-byte; nothing new is added to the
[allowed differences](#allowed-differences) list.

### Test mapping: adopt-skills

[`tests/test_adopt_skills.test.ts`](../tests/test_adopt_skills.test.ts)
mirrors `tests/test_adopt_skills.py`
test-for-test under `node:test`, keeping the Python method names. The
file contains 32 `AdoptSkillsTests` methods, and all 32 have
counterparts.

| Python test class | TypeScript suite | Python tests | TS tests |
|---|---|---|---|
| `AdoptSkillsTests` | `AdoptSkillsTests` | 32 | 32 |
| — | `AdoptionRecordFixtureTests` | — | 1 |

`AdoptionRecordFixtureTests` has no Python counterpart: it reads
[`tests/fixtures/adopted-consumer/`](../tests/fixtures/adopted-consumer/),
a consumer whose canonical copy, manifest record and harness links were
produced by the authoritative Python `adopt --apply`, and proves the
TypeScript `skill_signature` recomputes the recorded `sha256:` hash and
that a rerun reports `nothing to do` — the "existing records verify
unchanged" acceptance criterion.

### Parity cases: adopt-skills

Registered cases (59): `adopt-dry-run`, `adopt-check`, `adopt-apply`,
`adopt-apply-command`, `adopt-nothing`, `adopt-dedupe`,
`adopt-dedupe-apply`, `adopt-apply-conflict`, `adopt-update-drift`,
`adopt-relink`, `adopt-refuse-differ`, `adopt-refuse-toolkit`,
`adopt-refuse-unsafe`, `adopt-refuse-canonical-differ`,
`adopt-refuse-canonical-file`, `adopt-note-alias`,
`adopt-note-hidden-symlink`, `adopt-note-dangling`,
`adopt-note-no-skillmd`, `adopt-note-broken-link`,
`adopt-manifest-boolean-version`, `adopt-error-storage`,
`adopt-error-manifest-symlink`, `adopt-error-manifest-unrecognized`,
`adopt-error-manifest-name`, `adopt-error-manifest-json`,
`adopt-error-manifest-undecodable`, `adopt-error-escape`,
`adopt-error-excluded`, `adopt-error-missing-project`,
`adopt-cli-help`, `adopt-cli-mutex`, `adopt-cli-mutex-reversed`,
`adopt-cli-ambiguous`, `adopt-cli-unknown-arg`,
`adopt-cli-project-missing-arg`, `adopt-cli-command-missing-arg`,
`adopt-cli-apply-explicit`, `adopt-cli-separator`,
`adopt-cli-symlinked-entry`, `adopt-apply-path-sort`,
`adopt-apply-frontmatter-line-separators`,
`adopt-refuse-canonical-unsafe`, `adopt-refuse-canonical-link`,
`adopt-error-storage-file`, `adopt-error-storage-skills`,
`adopt-error-manifest-directory`, `adopt-error-manifest-null`,
`adopt-error-manifest-skills-list`, `adopt-error-manifest-record`,
`adopt-error-invalid-name`, `adopt-note-skillmd-link`,
`adopt-skills-not-dir`, `adopt-skills-alias-target`,
`adopt-update-dry-run`, `adopt-relink-dry-run`,
`adopt-apply-skillmd-undecodable`, `adopt-apply-no-frontmatter`,
`adopt-update-backup-occupied`.

The three modes are `adopt-dry-run` (default), `adopt-check` (explicit
dry-run alias) and `adopt-apply`. Refusal/report paths are split by
prefix: `adopt-refuse-*` (copies differ, toolkit clash, unsafe entries,
canonical conflicts), `adopt-note-*` (aliases, hidden symlinks, dangling
skills links, missing or linked `SKILL.md`, broken adopted links) and
`adopt-error-*` (redirected storage, unsafe/invalid manifests, path
escapes, excluded targets, missing project). `adopt-cli-*` cases cover
argparse diagnostics and pin `COLUMNS=80` through `env` so usage/help
wrapping is deterministic. `prepareAdopted` runs the Python command
itself inside `prepare`, so update, relink, broken-link and
record-recognition cases start from Python-produced hashes and
provenance — the same trick install uses for baseline installs.

### Review fixes: adopt-skills parity hardening

An independent review of the dirty #115 tree found two strict parity
gaps the registered cases missed, each fixed in TypeScript with a
regression that fails before the fix, plus coverage for refusal, note
and `ValueError` paths no case exercised:

- **`sorted(copies[name])` compares `Path` objects.** CPython orders
  paths by `parts` tuples — component-wise code points, a shorter tuple
  first on a shared prefix — so `.a/skills/palette` precedes
  `.a-b/skills/palette` even though `'/'` sorts after `'-'` in a raw
  string compare. The plan's `paths` sort now uses a local parts
  comparator (`comparePathParts`); `sorted(iterdir())` calls keep the
  string compare because a shared parent reduces the parts compare to
  the entry name, and `sorted(files)` inside `skill_signature` already
  sorts relative posix strings. Parity case: `adopt-apply-path-sort`.
- **Frontmatter `.` and line separators.** Python `.` excludes only
  `'\n'` — it matches `'\r'`, U+2028 and U+2029, which JavaScript `.`
  treats as line terminators. `frontmatter_fields` now uses an explicit
  `[\s\S]` class so `source: a\u2028b` records identically; the digest
  is unchanged. Parity case:
  `adopt-apply-frontmatter-line-separators`.
- **Refusal/report coverage.** The remaining cases close paths the
  first pass missed: `canonical contains unsafe entries`
  (`adopt-refuse-canonical-unsafe`), a symlink canonical
  (`adopt-refuse-canonical-link`), non-object manifest records
  (`adopt-error-manifest-record`), non-dict manifests and `skills`
  (`adopt-error-manifest-null`, `adopt-error-manifest-skills-list`), a
  manifest path that is a directory (`adopt-error-manifest-directory`),
  unsafe `.agents` as a file and `.agents/skills` as a link
  (`adopt-error-storage-file`, `adopt-error-storage-skills`), plan-time
  name validation on a real `a\b` directory
  (`adopt-error-invalid-name`), a symlinked `SKILL.md` marker
  (`adopt-note-skillmd-link`), a non-directory `skills` entry
  (`adopt-skills-not-dir`), two `skills` links resolving to one real
  directory (`adopt-skills-alias-target`), dry-run `update:`/`relink:`
  report lines (`adopt-update-dry-run`, `adopt-relink-dry-run`) and the
  frontmatter early returns (`adopt-apply-skillmd-undecodable`,
  `adopt-apply-no-frontmatter`).

A second review pass found the update-failure restore renaming to a
literal `.{name}.adopt-failed` — the braces are not JavaScript
interpolation — now `` `.${name}.adopt-failed` ``, matching
`f".{name}.adopt-failed"`. It also showed the occupied-backup skip is
reachable in one invocation: `adopt-update-backup-occupied`
precreates `.agents/skills/.palette.adopt-backup` and expects
`skipped: palette backup path occupied; preserved`. The paths still
uncovered on purpose are the ones that need a mid-run mutation no
single CLI invocation can produce — the `changed since planning` and
`changed during apply` `skipped:` lines and the mutation
`ValueError`s — plus `Destination escapes project`, unreachable
while preflight and the resolved-folder checks hold, and the
`.adopt-failed` restore, unreachable in one invocation because the
rename cannot change content between the `unchanged_copy` check and
the post-move signature.

## setup_memory, setup_memory_connections, memory_preflight (issue #114)

Three modules port function-for-function:

- [`scripts/setup_memory.ts`](../scripts/setup_memory.ts) mirrors
  `scripts/setup_memory.py`: schema-2
  routing validation (`config_data`), policy text generation
  (`policy`/`expected_instructions`/`previous_generated`),
  `connection_selection` marker handling and its customized/stale
  instruction gate, `.gitignore` management, capability checks, the
  `install()` preflight (skill linking, AGENTS.md policy blocks, retired
  and unmanaged link reporting), check mode, and the CLI including the
  `--skills` migration error.
- [`scripts/setup_memory_connections.ts`](../scripts/setup_memory_connections.ts)
  mirrors `scripts/setup_memory_connections.py`:
  the standalone `--project`/`--check`/`--profile` front end over
  `memory_connections`' render/check boundary, the deferred #113 slice.
- [`scripts/memory_preflight.ts`](../scripts/memory_preflight.ts) mirrors
  `scripts/memory_preflight.py`: the
  read-only pre-update record — capability choice, upstream-skill state
  from `skills-lock.json` plus the link tree, reviewed release verdicts
  (`1.0.0` → `v1.0.0`, `0.23.2`/`0.24.0`/`0.24.1` → the legacy ref),
  generated-instruction state, library pin/version through `runGit`, the
  `json.dumps(record, indent=2)` stdout contract and the verdict exit map.

Shared surface the port needed from the merged modules:

- `memory_connections.ts` now exports `tomlLoads` (the smol-toml load
  path carrying the tomllib-verdict re-scan) and the three `json.dumps`
  shapes: `jsonDumps` (`indent=2`), `jsonDumpsDefault` (compact, for
  lock-file writes in tests) and `jsonDumpsSorted`.
- `install.ts`'s `install`/`prepare_install`/`read_capabilities`/
  `write_capabilities` drive the setup orchestration exactly as
  `install.py` does — the TypeScript setup module calls the TypeScript
  install module, so the printed `installed:`/`linked:`/`checked:` lines
  come from the ported boundary on both sides.

Python details reproduced where parity requires them:

- `json.dumps` output for the CLI's outcome record uses `pyJson`
  (compact separators, `ensure_ascii` escapes — em-dashes in warning
  strings surface as `\u2014` in the opt-in JSON).
- `ValueError`/`RuntimeError` names and message text come from
  `pyerrors`, matching Python's stderr diagnostics and traceback tails.
- TOML reads go through `tomlLoads`, so accepted/rejected documents and
  parsed values agree with `tomllib`; the only embedded-parser wording
  that can diverge stays inside allowed difference 3 (none of the three
  CLIs' parity cases produce it).
- `Path.resolve()`/`Path.exists()`/`expanduser`/`home()` semantics use
  `pyResolve`/the `pyio` helpers, so `.agent-workflows` symlink targets
  and machine-scope lookups behave identically.
- Both new CLIs share the argparse-faithful front end conventions from
  `install.ts`: `--opt=value` forms, abbreviations, unrecognized/required
  diagnostics, and help text that matches argparse on Python 3.12 anyway
  (allowed difference 1 remains the only sanctioned divergence).

### Test mapping (#114)

[`tests/test_setup_memory.test.ts`](../tests/test_setup_memory.test.ts)
ports all 31 methods of
`tests/test_setup_memory.py` plus the
three orchestration tests #113 deferred to this issue (all keep their
Python names and now live here):

- `test_optin_upgrade_of_existing_routing_is_stale_not_customized`
- `test_stale_or_customized_instructions_block_worktree_render`
- `test_unknown_and_duplicate_clients_are_rejected`

[`tests/test_memory_preflight.test.ts`](../tests/test_memory_preflight.test.ts)
ports all 6 methods of
`tests/test_memory_preflight.py`
test-for-test under the same naming rule.

| Python test file | TypeScript suite | Python tests | TS tests |
|---|---|---|---|
| `test_setup_memory.py` | `test_setup_memory.test.ts` | 31 | 31 |
| `test_memory_connections.py` (three deferred) | `test_setup_memory.test.ts` | 3 | 3 |
| `test_memory_preflight.py` | `test_memory_preflight.test.ts` | 6 | 6 |

### Parity cases: #114

The new cases ran real command pairs — `scripts/*.py` vs
`scripts/*.ts` — on `tests/fixtures/parity/consumer`. `prepare` gave
each disposable copy a git worktree, an `AGENTS.md`, a `.agent-workflows`
symlink to the repository checkout (the real consumer layout, so
`setup()`'s source check and `memory_preflight`'s library pin resolve
through it), a recorded capability, and a `routing.toml`; baselines are
produced by running the Python `setup_memory.py` itself identically in
both copies. Connection cases run under `MEMORY_HOME_ENV`: an
existing-but-empty fake `HOME`/`XDG_CONFIG_HOME`/`CODEX_HOME` makes every
machine-scope client lookup deterministically miss while real
`XDG_DATA_HOME`/`XDG_CACHE_HOME` keep `uv run` from re-resolving its
managed interpreter under the fake home. `.git` internals stay pruned
via `GIT_TREE_IGNORE`.

`setup_memory` cases: `setup-memory-portable`, `setup-memory-check`,
`setup-memory-check-missing-routing`,
`setup-memory-check-stale-instructions`, `setup-memory-share-config`,
`setup-memory-claude-skills`, `setup-memory-customized-instructions`,
`setup-memory-portable-differs`, `setup-memory-declined`,
`setup-memory-local-override`, `setup-memory-connections-optin`,
`setup-memory-connections-check`,
`setup-memory-connections-missing-profile`,
`setup-memory-cli-skills-migration`, `setup-memory-cli-unrecognized`,
`setup-memory-cli-missing-project`, `setup-memory-cli-help`.

`setup_memory_connections` cases: `connections-render` (baseline with
generated files deleted so the render reports them again),
`connections-check` (fails on the deterministic missing Codex trust and
Claude approval prerequisites under the fake home),
`connections-not-configured`, `connections-missing-profile`,
`connections-cli-missing-project`, `connections-cli-unrecognized`,
`connections-cli-help`.

`memory_preflight` cases (the JSON record is compared byte-for-byte for
every `--server-release` shape): `preflight-not-applicable`,
`preflight-unrecorded`, `preflight-unknown-skills`,
`preflight-compatible`, `preflight-compatible-legacy-0.23.2`,
`preflight-compatible-legacy-0.24.0`,
`preflight-compatible-legacy-0.24.1`, `preflight-compatible-v-prefix`,
`preflight-incompatible`, `preflight-unknown-release`,
`preflight-no-server-release`, `preflight-instructions-current`,
`preflight-broken-lock`, `preflight-cli-missing-project`,
`preflight-cli-unrecognized`, `preflight-cli-help`.

### Review fixes (#114)

Independent review of the #114 port surfaced three behavioral gaps; all
are fixed on the TypeScript side only:

- `setup_memory_connections.ts` now runs Python's explicit git gate in
  `runMain`: `git -C <root> rev-parse --show-toplevel` must succeed and
  its resolved output must equal the resolved `--project`, else the CLI
  prints `Project must be the active worktree root` and exits 1 — for
  both a worktree subdirectory and a directory outside Git.
- `memory_preflight.ts` `isDict` now excludes `PyFloat` wrappers, so a
  JSON number as the `skills-lock.json` top level raises the same
  `'float' object has no attribute 'get'` diagnostic and exits 1.
- All three CLIs model argparse's `consume_optional` short-option loop
  for `-h`: queued help actions fire when the cluster tail names no
  further option (`-hfoo`, `-hh`, `-hhx`, `-hx` exit 0), while
  `=`-separated or `-`-leading remainders remain
  `ignored explicit argument` errors (exit 2).

New node:test coverage: `test_connections_cli_requires_worktree_root`
and `test_cli_short_help_tails_print_help` in
`test_setup_memory.test.ts` (the latter drives both setup and
connections CLIs); `test_cli_short_help_tails_print_help` plus a float
top-level lock assertion in `test_memory_preflight.test.ts`.

New parity cases (same fixture, real command pairs, byte-for-byte
comparison): `setup-memory-check-missing-instructions`,
`setup-memory-check-missing-policy-block`,
`setup-memory-check-missing-ignore-entry`,
`setup-memory-check-missing-skill-link`, `connections-check-clean`
(OpenCode-only routing so no machine trust/approval records are
needed), `connections-check-not-configured`,
`connections-cli-subdirectory`, `connections-cli-not-git`,
`connections-cli-help-tail`, `setup-memory-cli-help-tail`,
`preflight-cli-help-tail`, and `preflight-lock-float`.

## MCP configure module (issue #116)

[`scripts/mcp_configure.ts`](../scripts/mcp_configure.ts) ports
`scripts/mcp_configure.py`: client
inspection for Claude, Codex and OpenCode, service classification, the
`check`/`plan`/`apply` CLI, plan digests and stale-plan refusal,
line-level TOML span editing, and the redaction allowlists. The module
stays pure and offline: no subprocess, socket or environment read —
machine data arrives only through the `machine` descriptor.

Byte contracts called out in the issue:

- Report, plan and apply output go through the `jsonDumps`
  (`json.dumps(value, indent=2)`, insertion order) exported from
  [`memory_connections.ts`](../scripts/memory_connections.ts), plus the
  trailing newline the CLI adds. `pyJson` sorts keys and is never used
  for these documents.
- `plan["files"]` iterates a Python `set` of destination paths, so its
  key order is hash-dependent: CPython emits
  `.claude/settings.local.json` before `.mcp.json` for the Claude
  add/approval action set under `PYTHONHASHSEED=0`, and the port
  reproduces that seeded order. Parity cases pin `PYTHONHASHSEED=0`
  through `env` so the emitted plan is deterministic.
- Plan validation accepts `"version": 1` through `pyEq` because Python
  `1 == 1` and `json.loads` may hand back the same document smol-toml's
  JSON path typed as `bigint`; a strict `=== 1` refused plans Python
  accepted.
- TOML writes re-emit only the touched `[mcp_servers.<name>]` table
  spans; comments and unrelated tables survive byte-for-byte (asserted
  by `test_round_trip_per_client_and_unrelated_preserved`).
- The CLI mirrors argparse exactly: usage and help bytes, `invalid
  choice`, `the following arguments are required`, ambiguous-option and
  unrecognized-argument diagnostics, `--` handling, and exit status 2.
  Program naming stays `mcp_configure.py` in every diagnostic, matching
  `prog`.

Two owner decisions relax exact matching in this slice; both are
recorded in the allowed-differences list. Plan-byte parity is the
seed-0 order: the parity harness stays pinned to `PYTHONHASHSEED=0`
and no other seed's order is reproduced (allowed difference 4). TOML
datetime fractional seconds may be milliseconds — parsed values can
lose sub-millisecond digits while accept/reject stays exact (allowed
difference 5).

Import cycle, matching the Python shape: `mcp_configure.ts` statically
imports `atomic`, `parse_jsonc`, `tomlLoads` and `jsonDumps` from
`memory_connections.ts` (the last two were private and are now
exported); `memory_connections.ts` calls `inspectClient` and
`equivalentUrl` through `createRequire(import.meta.url)` inside
`memoryAlignment`, mirroring `memory_connections.py`'s function-level
`import mcp_configure`. `createRequire` keeps `planConnectionFiles`
synchronous — its public signature and results are unchanged, and the
private inspection subset was deleted in favour of the full module.

### Test mapping: mcp-configure

[`tests/test_mcp_configure.test.ts`](../tests/test_mcp_configure.test.ts)
mirrors `tests/test_mcp_configure.py`
test-for-test under `node:test`, keeping the Python method names and
grouping them in the same class order as file sections. All
69 Python methods have counterparts; none needed a recorded exception.

| Python test class | File section | Python tests | TS tests |
|---|---|---|---|
| `InspectionTests` | `InspectionTests` | 7 | 10 (adds `test_codex_toml_date_env_is_not_a_table`, `test_codex_toml_date_entry_is_not_a_table`, `test_codex_toml_date_http_headers_is_not_a_table`) |
| `ClassificationTests` | `ClassificationTests` | 6 | 6 |
| `MappingTests` | `MappingTests` | 4 | 4 |
| `ManifestTests` | `ManifestTests` | 2 | 2 |
| `RedactionTests` | `RedactionTests` | 2 | 2 |
| `PlanTests` | `PlanTests` | 9 | 9 |
| `ApplyTests` | `ApplyTests` | 16 | 18 (adds `test_apply_preserves_unrelated_toml_dates`, `test_toml_dates_compare_by_kind_and_value`) |
| `CliTests` | `CliTests` | 7 | 7 |
| `ReviewFindingTests` | `ReviewFindingTests` | 16 | 16 |

### Parity cases: mcp-configure

`check` runs on every mcp-configure fixture —
`mcp-configure-check-project`, `-no-manifest`, `-broad-grant`,
`-check-apply-project`, `-check-apply-bare`. `mcp-configure-plan`
emits the plan on stdout so `runCase`'s `<consumer>` path
normalization applies (the plan embeds the absolute `--root`, the one
legitimate cross-copy difference), proving byte-identical plan bytes
under the pinned seed. The cross-apply pair —
`mcp-configure-apply-python-plan` and
`mcp-configure-apply-typescript-plan` — writes a confirmed plan with
one runtime in `prepare` and compares `apply` on both sides, proving
plan-file compatibility in both directions.
`mcp-configure-apply-no-confirm` and `-apply-unconfirmed-plan` cover
the refusal paths; `mcp-configure-usage-invalid-command` and
`-usage-unknown-client` cover argparse diagnostics (exit 2). The apply
cases ignore `plan.json` in the tree comparison because the refreshed
plan still embeds the absolute root; every other written byte is
compared.

## T3 readiness and bootstrap (issue #117)

Three modules port the T3 boundary function-for-function:

- [`scripts/t3_readiness.ts`](../scripts/t3_readiness.ts) mirrors
  `scripts/t3_readiness.py`: recorded-choice
  load/validation (`load`, `read_config`), the pinned-submodule contract
  (`pinned_library`, gitlink/index/HEAD pin equality, clean and
  initialized checks, standalone verification), capability
  separation, selection drift (`assess`), safe restore
  (`restore_missing` — optimistic same-bytes skips, symlink refusal,
  preflight-then-write), generated-asset planning (`generated_plan`,
  action identity/command/role detection, composed-action preservation,
  `t3.json` schema rules, the 50-action cap), `configure`,
  `check_action`, `record_choice` (declined/enabled, `--config-file`,
  `--replace-choice`), and the routing-source surface
  (`routing_source_status`, `reconcile_routing_source`,
  `source_must_move`, ignore-fallback refusal).
- [`scripts/t3_bootstrap.ts`](../scripts/t3_bootstrap.ts) mirrors
  `scripts/t3_bootstrap.py`: config or
  default library resolution, `_verify_library` (registered, clean,
  initialized, exact gitlink pin), submodule init, and the helper
  delegation (`--check` reports prerequisites; the default run spawns
  readiness `--prepare`).
- [`scripts/t3_bootstrap.mjs`](../scripts/t3_bootstrap.mjs) is the plain
  JavaScript consumer template for the transition. At runtime it resolves
  the pinned library the same way `t3_bootstrap.py` does, dynamically
  imports the pin's `scripts/t3_bootstrap.ts` and calls its `main`
  forwarding argv. A pin that still carries only `scripts/t3_bootstrap.py`
  is reported — `Pinned t3_bootstrap.py needs migration to
  t3_bootstrap.ts`, exit 1, no traceback.

### Bootstrap generation (post-cutover)

The transitional `AW_T3_BOOTSTRAP` flag was removed at cutover: Node is
the only supported generator. `t3_readiness.ts` writes
`.agent-workflows-t3.mjs` (the pin's `scripts/t3_bootstrap.mjs` bytes)
and sets the action command to `node .agent-workflows-t3.mjs`. An
existing `.agent-workflows-t3.py` is reported as needing migration —
`Generated bootstrap .agent-workflows-t3.py needs migration to
.agent-workflows-t3.mjs`, exit 1 — never as broken, customized or
corrupt, and `--check` never writes it away. `--configure-action` may
write the `.mjs` and migrate the action command while leaving the `.py`
in place.

`load_helper(library, name)` resolves `scripts/<stem>.ts` inside the
pin; a pin carrying only the `.py` helper fails with `Pinned <name>
needs migration to <stem>.ts` (caught, one-line stderr, exit 1), and a
pin with neither fails like Python's `safe_path` did for a missing
file.

The TypeScript bootstrap resolves the readiness interpreter as
`process.execPath`. A pin missing `t3_readiness.ts` but carrying
`t3_readiness.py` reports `Pinned t3_readiness.py needs migration to
t3_readiness.ts`, exit 1, no traceback.

### Test mapping (#117)

[`tests/test_t3_readiness.test.ts`](../tests/test_t3_readiness.test.ts)
ports all 39 methods of
`tests/test_t3_readiness.py` under their
Python names, plus the flag/cross-port coverage that has no Python
counterpart:

- `test_readiness_reports_python_only_helper_pin`
- `test_old_bootstrap_reports_migration_under_node_flag`
- `test_node_flag_configure_writes_mjs_and_migrates_action`
- `test_generated_mjs_runs_under_node`

[`tests/test_t3_bootstrap.test.ts`](../tests/test_t3_bootstrap.test.ts)
ports all 7 methods of
`tests/test_t3_bootstrap.py` plus:

- `test_node_bootstrap_reports_pinned_python_template` (`.mjs` against a
  Python-only pin)
- `test_node_bootstrap_reports_pinned_python_readiness` (`t3_bootstrap.ts`
  under the flag against a pin missing `t3_readiness.ts`)

The Python fixture's worktree end-to-end runs
(`test_end_to_end_drift_repair_then_fresh_worktree_bootstrap`,
`test_fresh_worktree_flags_routing_source_stale_before_optin`) spawn the
generated `.agent-workflows-t3.mjs` under `AW_T3_BOOTSTRAP=node` — the
Node-side equivalent of their `.py` invocations.

| Python test file | TypeScript suite | Python tests | TS tests |
|---|---|---|---|
| `test_t3_readiness.py` | `test_t3_readiness.test.ts` | 39 | 39 + 4 |
| `test_t3_bootstrap.py` | `test_t3_bootstrap.test.ts` | 7 | 7 + 2 |

### Parity cases: #117

`tests/parity/harness.ts` gained a second `PARITY_CASES.push(...)` after
the #114 block. Each disposable consumer pins a library carrying both
implementations; baselines are produced by the Python commands.

Readiness: `t3-readiness-check-ready`, `t3-readiness-check-missing-assets`,
`t3-readiness-check-missing-link`, `t3-readiness-prepare`,
`t3-readiness-configure-action`, `t3-readiness-record-choice-declined`,
`t3-readiness-record-choice-enabled`,
`t3-readiness-record-choice-invalid`,
`t3-readiness-record-choice-already-recorded`,
`t3-readiness-record-choice-replace`, `t3-readiness-check-routing-source`,
`t3-readiness-check-routing-source-drift`,
`t3-readiness-reconcile-routing-source`,
`t3-readiness-check-routing-source-declined`,
`t3-readiness-replace-choice-requires-record`, `t3-readiness-help`,
`t3-readiness-usage-missing-mode`,
`t3-readiness-usage-conflicting-modes`,
`t3-readiness-usage-invalid-choice`.

Bootstrap: `t3-bootstrap-check`, `t3-bootstrap-default`,
`t3-bootstrap-uninitialized`, `t3-bootstrap-help`.

The `AW_T3_BOOTSTRAP=node` divergences (`.mjs` generation, the migration
diagnostics, `.py`-only and `.ts`-only pins) are covered by the
`node:test` cross cases above rather than Python-versus-TypeScript
parity, which would disagree by design.

### Review fixes for #117

- `scripts/t3_bootstrap.mjs` is now the trusted copy in full: it parses
  argv first (usage errors and `--help` never touch the repository),
  then performs `t3_bootstrap.py` `bootstrap()`'s checks in order —
  worktree root, recorded choice, base ref, safe-relative-path and
  gitlink checks — before any import. `--check` is read-only: an
  uninitialized pin is reported (`T3 bootstrap: Pinned library submodule
  is not initialized; run bootstrap without --check`, exit 1) and never
  initialized. A default run initializes only after those checks, then
  verifies the helper `scripts/t3_bootstrap.ts` — a real non-symlink
  file inside the pin whose bytes equal `git show
  HEAD:scripts/t3_bootstrap.ts` — before setting
  `process.env.AW_T3_BOOTSTRAP = 'node'` and importing it. The forced
  flag keeps the recorded `node .agent-workflows-t3.mjs` action and the
  Node readiness helper without the caller passing the variable; direct
  `node scripts/t3_bootstrap.ts` stays Python-compatible. A pin carrying
  only `t3_bootstrap.py` reports `Pinned t3_bootstrap.py needs migration
  to t3_bootstrap.ts`, exit 1, no traceback; a pin carrying neither
  reports `pinned library scripts/t3_bootstrap.ts is unavailable` under
  the `T3 bootstrap: ` prefix, and unsafe helpers keep the Python
  `ValueError` texts.
- `memory_helper` in `scripts/t3_readiness.ts` now requires the pinned
  `memory_connections` helper through `load_helper(library,
  'memory_connections.py')` before importing `setup_memory.ts`: a pin
  missing both files reports the `safe_path` `Missing path:` error
  (exit 1, no stack), a `.py`-only pin reports the migration `ValueError`,
  and `setup_memory.ts` is imported only when `memory_connections.ts` is
  a real file inside the pin.
- The `t3_readiness.ts` argument parser matches CPython argparse on a
  repeated mutex option: repeating the same mode option is accepted (a
  `store_true` stays true, a valued option keeps the last value) while a
  different mode in the group is still exit 2.
- Parity bootstrap cases invoked a bootstrap whose script directory was
  the disposable consumer: `{consumer}/.agent-workflows-t3.py` on the
  Python side and the test-only driver `tests/parity/t3_bootstrap_driver.ts`
  (which calls `main(process.argv.slice(2), process.cwd())`) on the
  TypeScript side — never `--project`, which neither bootstrap accepts.
  `t3-bootstrap-check` covers `--check` against an initialized pin,
  `t3-bootstrap-default` covers the default run delegating to readiness
  `--prepare`, and `t3-bootstrap-check-uninitialized` (renamed) covers
  `--check` against a deinitialized pin. `t3-readiness-prepare` starts
  from a configured consumer so `--prepare` recreates a removed asset,
  and `t3-readiness-record-choice-replace` reviews a file that differs
  from the recorded choice. Added `t3-readiness-check-repeated-mode`,
  `t3-bootstrap-check-repeated` and `t3-bootstrap-usage-unknown-argument`.
- The generated `.mjs` now runs `t3_bootstrap.py`'s readiness-helper
  trust check before the TypeScript one: `scripts/t3_readiness.py` must
  be a real non-symlink file inside the pin whose bytes equal `git show
  HEAD:scripts/t3_readiness.py`, and its diagnostics stay Python's
  (`Pinned t3_readiness.py helper is missing or unsafe`, `Pinned helper
  resolves outside the library`, `Pinned helper content differs from
  library HEAD`) — a pin missing the readiness helper reports it even
  when `t3_bootstrap.ts` is also absent. Only then is
  `scripts/t3_bootstrap.ts` required and byte-verified before import:
  a `.py`-only pin keeps the migration line while a pin with neither
  reports `T3 bootstrap: pinned library scripts/t3_bootstrap.ts is
  unavailable`. The recorded-choice load inlines the
  `scripts/lib/pyloads.ts` scanner so a malformed
  `.agent-workflows-t3.json` reports CPython's `str(JSONDecodeError)` —
  `{msg}: line {lineno} column {colno} (char {pos})` — never V8's
  `JSON.parse` wording.
- The generated `.mjs` now reads the recorded choice through an inlined
  `scripts/lib/pyio.ts` port: a strict UTF-8 decode whose failure raises
  `UnicodeDecodeError` — reaching stderr unwrapped as `T3 bootstrap:
  'utf-8' codec can't decode byte 0xNN in position N: reason` (a
  `ValueError`, not the `OSError`/`JSONDecodeError` `Cannot read`
  covers) — universal newlines folded to `\n` before the JSON scan so
  `char` positions index the text Python scanned, and `Cannot read`
  errno failures formatted `[Errno N] {strerror}: '{path}'` by an
  inlined `pyOsError`. `t3_bootstrap.ts` `_load` likewise feeds
  `pyOsError` the raw `readFileSync` errno error — `readText`'s rename
  drops the code/path it formats — matching `setup_memory.ts`'s
  `readPortable` pattern. `node:test` cases compare `.mjs --check`
  stderr and exit status against the `.py` copy on a `0xff` legacy
  `skills` byte, both `\r\n` and bare `\r` fixtures, and an unreadable
  config.
- `t3_readiness.ts` reads its `read_text` inputs through a
  `readTextErrno` helper shaped on `setup_memory.ts`'s `readPortable`:
  `pyDecodeUtf8(readFileSync(path))`, universal newlines, and the raw
  errno error passed to `pyOsError` — `readText`'s rename drops the
  code/path it formats, so the helper reached stderr as Node's `EACCES:
  permission denied, open '...'` instead of Python's `[Errno 13]
  Permission denied: '...'`. The fix covers `load`, the `AGENTS.md`
  reference-pointer read in `prerequisites`, and the `--config-file`
  read in `record_choice`: all three sites where Python's `OSError`
  propagates to `main` unwrapped (no `Cannot read` cover). A `node:test`
  case repeats the reviewer's `chmod 000` probe on the recorded choice
  and compares `--check` stderr bytes and exit status against the
  Python 3.12 reference.
- `t3_readiness.ts` no longer imports `jsonDumps` from the sibling
  `memory_connections.ts` at module scope: Node resolved that import
  while loading the module, before `load_helper` could report the pin's
  missing helper, so a declined `--check` against a pin carrying neither
  `memory_connections` file crashed `ERR_MODULE_NOT_FOUND` (exit 1, Node
  stack) where Python prints the declined line and exits 0. The dumper
  now resolves through a function-scoped `load_helper` call against the
  running module's own pin — only where JSON is serialized
  (`action_plan`, the `record_choice` manifest write, the routing-source
  repoint) — so a serialization path on a helperless pin keeps the
  `Missing path:`/migration `ValueError` diagnostics and a
  non-serializing `--check` never evaluates the import. `action_plan`,
  `generated_plan` and `check_action` are `async` for the `await`. A
  `node:test` case runs the pinned copy
  (`<pin>/scripts/t3_readiness.ts` with both `memory_connections` files
  removed) against a declined configuration and compares exit status,
  stdout and stderr with the pinned `t3_readiness.py`.
