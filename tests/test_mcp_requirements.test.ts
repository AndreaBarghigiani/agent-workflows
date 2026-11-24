/**
 * `node:test` counterparts for `tests/test_mcp_requirements.py`, exercising
 * `scripts/mcp_requirements.ts`. Case tables mirror the Python file; the
 * parity drivers additionally compare full diagnostic output byte-for-byte.
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import {
  applies,
  diagnostics,
  load,
  loadManifest,
  readiness,
  unmet,
} from '../scripts/mcp_requirements.ts';

type Dict = Record<string, unknown>;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'mcp-requirements');
const SCHEMA = join(ROOT, 'docs', 'mcp-requirements.schema.json');
const MEMORY_PROFILE =
  'machine-local profile $XDG_CONFIG_HOME/agent-workflows/memory-connection.toml' +
  ' (endpoint and bearer-token env-var name)';

// Every key the manifest contract defines; anything else would be a
// value-bearing field hiding behind additionalProperties.
const ALLOWED_KEYS = new Set([
  'version', 'services', 'id', 'purpose', 'required', 'workflows',
  'guidance', 'connection', 'credential_refs', 'verification', 'type',
  'url', 'auth', 'mechanism', 'credential_ref', 'command_ref',
  'local_config_ref', 'description', 'read_only',
]);

function validService(overrides: Dict = {}): Dict {
  return {
    id: 'example',
    purpose: 'An example service.',
    required: true,
    workflows: ['*'],
    guidance: ['docs/mcp-requirements.md'],
    verification: { description: 'Read-only check.', read_only: true },
    ...overrides,
  };
}

function validManifest(overrides: Dict = {}): Dict {
  return { version: 1, services: [validService()], ...overrides };
}

function* keys(node: unknown): Generator<string> {
  if (typeof node === 'object' && node !== null && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) {
      yield key;
      yield* keys(value);
    }
  } else if (Array.isArray(node)) {
    for (const value of node) yield* keys(value);
  }
}

function* strings(node: unknown): Generator<string> {
  if (typeof node === 'object' && node !== null && !Array.isArray(node)) {
    for (const value of Object.values(node)) yield* strings(value);
  } else if (Array.isArray(node)) {
    for (const value of node) yield* strings(value);
  } else if (typeof node === 'string') {
    yield node;
  }
}

function problems(manifest: unknown): string {
  return diagnostics(manifest, ROOT).join('\n');
}

function fixtureNames(): string[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

describe('ManifestTests', () => {
  test('test_each_committed_fixture_is_a_valid_manifest', () => {
    const fixtures = fixtureNames();
    assert.ok(fixtures.length >= 4);
    for (const name of fixtures) {
      const data = load(join(FIXTURES, name), ROOT);
      assert.equal(data.get('version'), 1n, name);
      assert.ok((data.get('services') as unknown[]).length > 0, name);
      assert.deepEqual(diagnostics(data, ROOT), [], name);
    }
  });

  test('test_examples_cover_public_remote_auth_remote_and_stdio', () => {
    const publicRemote = load(join(FIXTURES, 'public-remote.json'), ROOT);
    const publicConnection = (
      publicRemote.get('services') as Map<string, unknown>[]
    )[0].get('connection') as Map<string, unknown>;
    assert.deepEqual(Object.fromEntries(publicConnection), {
      type: 'remote',
      url: 'https://docs.example.test/mcp',
    });
    const authed = load(join(FIXTURES, 'authenticated-remote.json'), ROOT);
    const mechanisms = new Set(
      (authed.get('services') as Map<string, unknown>[]).map(
        (s) =>
          (
            (s.get('connection') as Map<string, unknown>).get(
              'auth',
            ) as Map<string, unknown>
          ).get('mechanism'),
      ),
    );
    assert.deepEqual(mechanisms, new Set(['api-key', 'oauth']));
    const stdio = load(join(FIXTURES, 'local-stdio.json'), ROOT);
    const connection = (stdio.get('services') as Map<string, unknown>[])[0]
      .get('connection') as Map<string, unknown>;
    assert.equal(connection.get('type'), 'stdio');
    assert.equal(connection.get('command_ref'), 'LINT_MCP_COMMAND');
  });

  test('test_basic_memory_references_the_existing_contract', () => {
    const data = load(join(FIXTURES, 'basic-memory.json'), ROOT);
    const service = (data.get('services') as Map<string, unknown>[])[0];
    // Guidance references the shipped client-connection contract; the
    // endpoint and bearer-token env-var name stay in the machine-local
    // profile the manifest only points at.
    assert.ok(
      (service.get('guidance') as string[]).includes(
        '.agents/skills/setup-basic-memory/references/client-connection.md',
      ),
    );
    const connection = service.get('connection') as Map<string, unknown>;
    assert.ok(!connection.has('url'));
    assert.ok(
      (connection.get('local_config_ref') as string).includes(
        'memory-connection.toml',
      ),
    );
  });

  test('test_manifest_in_a_consumer_root_validates_against_that_root', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-req-'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n');
    mkdirSync(join(root, '.agents'));
    writeFileSync(
      join(root, '.agents', 'mcp-requirements.json'),
      JSON.stringify(
        validManifest({
          services: [validService({ guidance: ['docs/guide.md'] })],
        }),
      ),
    );
    const data = loadManifest(root);
    assert.equal(
      ((data?.get('services') ?? []) as Map<string, unknown>[])[0].get('id'),
      'example',
    );
  });

  test('test_absent_manifest_loads_none', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-req-'));
    assert.equal(loadManifest(root), null);
  });

  test('test_fixtures_carry_only_names_and_references', () => {
    for (const name of fixtureNames()) {
      const data = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
      for (const key of keys(data)) {
        assert.ok(ALLOWED_KEYS.has(key), `${name}: ${key}`);
      }
      for (const value of strings(data)) {
        assert.ok(!value.startsWith('/'), value);
      }
    }
  });
});

describe('DiagnosticTests', () => {
  test('test_unsupported_version_is_actionable', () => {
    let text = problems({ version: 2, services: [] });
    assert.ok(text.includes("unsupported 'version' 2"));
    assert.ok(text.includes('version 1'));
    assert.ok(text.includes('schema'));
    text = problems({ version: '1', services: [] });
    assert.ok(text.includes('must be the integer 1'));
  });

  test('test_duplicate_id_is_actionable', () => {
    const manifest = validManifest({
      services: [
        validService(),
        validService({ guidance: ['docs/integrations.md'] }),
      ],
    });
    const text = problems(manifest);
    assert.ok(text.includes("services[1].id 'example' duplicates"));
    assert.ok(text.includes('unique'));
  });

  test('test_invalid_declarations_are_named', () => {
    const without = (service: Dict, key: string) => {
      const copy = { ...service };
      delete copy[key];
      return copy;
    };
    const cases: [string, Dict][] = [
      ['manifest must be a JSON object', [] as unknown as Dict],
      ["missing required field 'version'", { services: [] }],
      ["missing required field 'services'", { version: 1 }],
      ["'services' must be an array", { version: 1, services: {} }],
      ['unexpected field', validManifest({ token: 'value' })],
      ["missing required field 'id'",
        validManifest({ services: [{ purpose: 'x' }] })],
      ['must match ^[a-z][a-z0-9-]*$',
        validManifest({ services: [validService({ id: 'Basic_Memory' })] })],
      ['purpose must be a non-empty string',
        validManifest({ services: [validService({ purpose: '  ' })] })],
      ['required must be a boolean',
        validManifest({ services: [validService({ required: 'yes' })] })],
      ['workflows must name at least one',
        validManifest({ services: [validService({ workflows: [] })] })],
      ["must be '*' or match",
        validManifest({ services: [validService({ workflows: ['Deploy'] })] })],
      ["missing required field 'guidance'",
        validManifest({ services: [without(validService(), 'guidance')] })],
      ['credential names only',
        validManifest({
          services: [validService({ credential_refs: ['api-key'] })],
        })],
      ['credential_refs must be an array',
        validManifest({
          services: [validService({ credential_refs: 'API_KEY' })],
        })],
      ["missing required field 'verification'",
        validManifest({ services: [without(validService(), 'verification')] })],
      ['read_only must be literally true',
        validManifest({
          services: [validService({
            verification: { description: 'x', read_only: 'yes' },
          })],
        })],
      ["verification: missing 'read_only'",
        validManifest({
          services: [validService({ verification: { description: 'x' } })],
        })],
      ['connection.type must be',
        validManifest({
          services: [validService({ connection: { type: 'sse' } })],
        })],
      ['exactly one of',
        validManifest({
          services: [validService({ connection: { type: 'remote' } })],
        })],
      ['must be an https URL',
        validManifest({
          services: [validService({
            connection: { type: 'remote', url: 'http://docs.example.test/mcp' },
          })],
        })],
      ['must not embed credentials',
        validManifest({
          services: [validService({
            connection: {
              type: 'remote', url: 'https://u:p@docs.example.test/mcp',
            },
          })],
        })],
      ["mechanism must be 'oauth' or 'api-key'",
        validManifest({
          services: [validService({
            connection: {
              type: 'remote', url: 'https://x.example.test/',
              auth: { mechanism: 'bearer' },
            },
          })],
        })],
      ["needs 'credential_ref'",
        validManifest({
          services: [validService({
            connection: {
              type: 'remote', url: 'https://x.example.test/',
              auth: { mechanism: 'api-key' },
            },
          })],
        })],
      ['interactive flow',
        validManifest({
          services: [validService({
            connection: {
              type: 'remote', url: 'https://x.example.test/',
              auth: { mechanism: 'oauth', credential_ref: 'X_TOKEN' },
            },
          })],
        })],
      ["needs 'command_ref'",
        validManifest({
          services: [validService({ connection: { type: 'stdio' } })],
        })],
      ['applies only to type',
        validManifest({
          services: [validService({
            connection: {
              type: 'stdio', command_ref: 'X_CMD',
              url: 'https://x.example.test/',
            },
          })],
        })],
    ];
    for (const [expected, manifest] of cases) {
      assert.ok(
        problems(manifest).includes(expected),
        `expected ${expected} in ${problems(manifest)}`,
      );
    }
  });

  test('test_reference_fields_reject_paths_commands_and_parameterized_urls', () => {
    const cases: [Dict, string][] = [
      [{ type: 'stdio', command_ref: '/home/alice/bin/mcp' },
        'must be a name matching'],
      [{ type: 'stdio', command_ref: 'npx -y some-mcp-server' },
        'must be a name matching'],
      [{ type: 'stdio', command_ref: 'X_CMD; curl evil.example' },
        'must be a name matching'],
      [{ type: 'remote', local_config_ref: '/home/alice/private/config.toml' },
        'must not be an absolute or machine-specific path'],
      [{ type: 'remote',
          local_config_ref: '~/.config/agent-workflows/config.toml' },
        'must not be an absolute or machine-specific path'],
      [{ type: 'remote', local_config_ref: 'C:\\Users\\alice\\config.toml' },
        'must not be an absolute or machine-specific path'],
      [{ type: 'remote', local_config_ref: 'profile at C:/memory/config.toml' },
        'must not be an absolute or machine-specific path'],
      [{ type: 'remote',
          url: 'https://docs.example.test/mcp?api_key=SYNTHETIC_SECRET' },
        'must not carry a query string'],
      [{ type: 'remote', url: 'https://docs.example.test/mcp?team=acme' },
        'must not carry a query string'],
      [{ type: 'remote', url: 'https://docs.example.test/mcp#credentials' },
        'must not carry a query string'],
      [{ type: 'remote', url: 'HTTPS://docs.example.test/mcp' },
        'must be an https URL'],
      [{ type: 'remote', url: 'https://docs.example.test/mcp?' },
        'must not carry a query string'],
      [{ type: 'remote', url: 'https://docs.example.test/mcp#' },
        'must not carry a query string'],
      [{ type: 'remote', url: 'https://@docs.example.test/mcp' },
        'must not embed credentials'],
      [{ type: 'remote', url: 'https://[broken/mcp' }, 'is not a valid URL'],
    ];
    for (const [connection, fragment] of cases) {
      const text = problems(
        validManifest({ services: [validService({ connection })] }),
      );
      assert.ok(text.includes(fragment), `expected ${fragment} in ${text}`);
    }
  });

  test('test_unresolved_guidance_references_are_actionable', () => {
    const cases: [string[], string][] = [
      [['docs/definitely-missing.md'], 'does not resolve'],
      [['/etc/passwd'], 'repo-relative'],
      [['docs/../escape'], 'repo-relative'],
      [[], 'at least one'],
    ];
    for (const [guidance, fragment] of cases) {
      const text = problems(
        validManifest({ services: [validService({ guidance })] }),
      );
      assert.ok(text.includes(fragment), `expected ${fragment} in ${text}`);
    }
  });

  test('test_every_problem_is_reported_together', () => {
    const manifest = validManifest({
      services: [
        validService({ id: 'Bad Id', purpose: '' }),
        validService({ required: 'yes' }),
      ],
    });
    assert.ok(diagnostics(manifest, ROOT).length > 2);
  });

  test('test_load_raises_with_the_full_diagnostic_list', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-req-'));
    const path = join(root, 'mcp-requirements.json');
    writeFileSync(path, JSON.stringify({ version: 9, services: {} }));
    assert.throws(() => load(path, root), /version/);
    writeFileSync(path, '{not json');
    assert.throws(() => load(path, root), /Unreadable/);
  });
});

describe('ReadinessTests', () => {
  const portable = (): Map<string, unknown> =>
    load(join(FIXTURES, 'portable.json'), ROOT);

  test('test_one_manifest_satisfies_two_different_machines', () => {
    // Machine A keeps the lint command in an exported env var and its
    // memory profile names endpoint https://memory-a.tailnet/mcp with
    // token env BASIC_MEMORY_API_TOKEN.
    const machineA = {
      env: ['TRACKER_API_TOKEN', 'LINT_MCP_COMMAND'],
      local_config_refs: {
        [MEMORY_PROFILE]: {
          endpoint: 'https://memory-a.tailnet/mcp',
          token_env: 'BASIC_MEMORY_API_TOKEN',
        },
      },
    };
    // Machine B resolves the same refs differently: the lint command is a
    // machine-local setting, and its memory profile names endpoint
    // https://nas.b.example/mcp with token env BM_TOKEN. The manifest —
    // and the refs — are unchanged.
    const machineB = {
      env: ['TRACKER_API_TOKEN'],
      local_config_refs: {
        [MEMORY_PROFILE]: {
          endpoint: 'https://nas.b.example/mcp',
          token_env: 'BM_TOKEN',
        },
        LINT_MCP_COMMAND: { setting: 'mise task lint-mcp' },
      },
    };
    for (const machine of [machineA, machineB]) {
      let outcome = readiness(portable(), machine, 'implement-issue');
      assert.equal(outcome['ready'], true, JSON.stringify(outcome));
      assert.deepEqual(
        new Set(outcome['satisfied'] as string[]),
        new Set(['issue-tracker', 'basic-memory', 'local-lint']),
      );
      outcome = readiness(portable(), machine, 'shape-issue');
      assert.equal(outcome['ready'], true, JSON.stringify(outcome));
      assert.deepEqual(
        new Set(outcome['satisfied'] as string[]),
        new Set(['issue-tracker', 'basic-memory']),
      );
    }
  });

  test('test_registration_name_can_differ_from_service_id', () => {
    const manifest = load(join(FIXTURES, 'basic-memory.json'), ROOT);
    const machine = { registrations: { 'basic-memory': ['basic_memory_nas'] } };
    assert.deepEqual(
      unmet((manifest.get('services') as Map<string, unknown>[])[0], machine),
      [],
    );
    const outcome = readiness(manifest, machine, 'deliver-issue');
    assert.equal(outcome['ready'], true);
    // Without any registration or local config the requirement is unmet,
    // but the identity stays 'basic-memory' — no rename is implied.
    const bare = readiness(manifest, {}, 'deliver-issue');
    assert.deepEqual(
      (bare['blocked'] as Dict[]).map((b) => b['id']),
      ['basic-memory'],
    );
  });

  test('test_required_unavailable_blocks_only_applicable_workflows', () => {
    // TRACKER_API_TOKEN is absent: the required tracker blocks every
    // workflow through '*', while the lint server (optional,
    // implement-issue only) never blocks anything.
    const outcome = readiness(portable(), {}, 'implement-issue');
    assert.equal(outcome['ready'], false);
    assert.deepEqual(
      (outcome['blocked'] as Dict[]).map((b) => b['id']),
      ['issue-tracker', 'basic-memory'],
    );
    assert.deepEqual(
      (outcome['degraded'] as Dict[]).map((d) => d['id']),
      ['local-lint'],
    );
  });

  test('test_scoped_required_service_does_not_block_other_workflows', () => {
    const manifest = validManifest({
      services: [validService({
        id: 'tracker', required: true, workflows: ['deliver-issue'],
        connection: {
          type: 'remote', url: 'https://x.example.test/',
          auth: { mechanism: 'api-key', credential_ref: 'TRACKER_API_TOKEN' },
        },
      })],
    });
    const blocked = readiness(manifest, {}, 'deliver-issue');
    assert.equal(blocked['ready'], false);
    assert.deepEqual(
      (blocked['blocked'] as Dict[]).map((b) => b['id']),
      ['tracker'],
    );
    assert.equal(
      readiness(manifest, {}, 'implement-issue')['ready'],
      true,
    );
  });

  test('test_optional_unavailable_never_blocks', () => {
    const manifest = validManifest({
      services: [validService({
        id: 'docs', required: false, workflows: ['*'],
        connection: { type: 'stdio', command_ref: 'DOCS_MCP_COMMAND' },
      })],
    });
    const outcome = readiness(manifest, {}, 'implement-issue');
    assert.equal(outcome['ready'], true);
    assert.deepEqual(
      (outcome['degraded'] as Dict[]).map((d) => d['id']),
      ['docs'],
    );
  });

  test('test_unmet_prerequisites_are_reported_per_service', () => {
    const manifest = validManifest({
      services: [validService({
        id: 'lint',
        connection: {
          type: 'stdio', command_ref: 'LINT_MCP_COMMAND',
          local_config_ref: 'lint notes',
        },
        credential_refs: ['LINT_BACKEND_TOKEN'],
      })],
    });
    const missing = unmet((manifest['services'] as Dict[])[0], {});
    assert.equal(missing.length, 3);
    const text = missing.join('\n');
    assert.ok(text.includes('LINT_MCP_COMMAND'));
    assert.ok(text.includes('lint notes'));
    assert.ok(text.includes('LINT_BACKEND_TOKEN'));
    const machine = {
      env: ['LINT_MCP_COMMAND', 'LINT_BACKEND_TOKEN'],
      local_config_refs: ['lint notes'],
    };
    assert.deepEqual(unmet((manifest['services'] as Dict[])[0], machine), []);
  });

  test('test_applies', () => {
    const star = validService({ workflows: ['*'] });
    assert.equal(applies(star, 'anything'), true);
    const scoped = validService({ workflows: ['deliver-issue'] });
    assert.equal(applies(scoped, 'deliver-issue'), true);
    assert.equal(applies(scoped, 'review-issue'), false);
  });
});

/**
 * The normative schema and the TypeScript validator decide alike.
 *
 * Guidance path resolution (repo-dependent) and identity uniqueness are
 * supplemental checks the schema cannot express; those cases are labelled
 * python_only/ts_only.
 */
describe('SchemaAgreementTests', () => {
  const validator: ValidateFunction = new Ajv2020().compile(
    JSON.parse(readFileSync(SCHEMA, 'utf8')),
  );

  const verdicts = (manifest: unknown): [boolean, boolean] => [
    Boolean(validator(manifest)),
    diagnostics(manifest, ROOT).length === 0,
  ];

  test('test_committed_fixtures_are_valid_under_both', () => {
    for (const name of fixtureNames()) {
      const manifest = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
      const [schemaValid, tsValid] = verdicts(manifest);
      assert.ok(schemaValid, name);
      assert.ok(tsValid, name);
    }
  });

  test('test_valid_connection_shapes_agree', () => {
    const connections: Dict[] = [
      { type: 'remote', url: 'https://docs.example.test/mcp' },
      { type: 'remote',
        local_config_ref: 'machine-local profile memory-connection.toml' },
      { type: 'remote', url: 'https://docs.example.test/mcp',
        auth: { mechanism: 'oauth' } },
      { type: 'remote', url: 'https://docs.example.test/mcp',
        auth: { mechanism: 'api-key', credential_ref: 'TRACKER_API_TOKEN' } },
      { type: 'stdio', command_ref: 'LINT_MCP_COMMAND' },
      { type: 'stdio', command_ref: 'LINT_MCP_COMMAND',
        local_config_ref: 'consumer toolchain notes for the server' },
    ];
    for (const connection of connections) {
      const [schemaValid, tsValid] = verdicts(
        validManifest({ services: [validService({ connection })] }),
      );
      assert.ok(schemaValid, JSON.stringify(connection));
      assert.ok(tsValid, JSON.stringify(connection));
    }
  });

  test('test_schema_invalid_implies_typescript_invalid', () => {
    const cases: [string, unknown][] = [
      ['version 2', { version: 2, services: [] }],
      ['version true', { version: true, services: [] }],
      ['missing version', { services: [] }],
      ['missing services', { version: 1 }],
      ['services not array', { version: 1, services: {} }],
      ['unexpected top field', validManifest({ extra: 'x' })],
      ['id pattern', validManifest({
        services: [validService({ id: 'Basic_Memory' })] })],
      ['whitespace purpose', validManifest({
        services: [validService({ purpose: '  ' })] })],
      ['required non-bool', validManifest({
        services: [validService({ required: 'yes' })] })],
      ['empty workflows', validManifest({
        services: [validService({ workflows: [] })] })],
      ['bad workflow name', validManifest({
        services: [validService({ workflows: ['Deploy'] })] })],
      ['empty guidance', validManifest({
        services: [validService({ guidance: [] })] })],
      ['bad credential_ref pattern', validManifest({
        services: [validService({ credential_refs: ['api-key'] })] })],
      ['read_only not literal true', validManifest({
        services: [validService({
          verification: { description: 'x', read_only: 'yes' } })] })],
      ['missing read_only', validManifest({
        services: [validService({ verification: { description: 'x' } })] })],
      ['connection type', validManifest({
        services: [validService({ connection: { type: 'sse' } })] })],
      ['remote with neither', validManifest({
        services: [validService({ connection: { type: 'remote' } })] })],
      ['remote with both', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://docs.example.test/mcp',
            local_config_ref: 'notes' } })] })],
      ['remote with command_ref', validManifest({
        services: [validService({
          connection: {
            type: 'remote', command_ref: 'X_CMD',
            url: 'https://x.example.test/' } })] })],
      ['stdio without command_ref', validManifest({
        services: [validService({ connection: { type: 'stdio' } })] })],
      ['stdio with url', validManifest({
        services: [validService({
          connection: {
            type: 'stdio', command_ref: 'X_CMD',
            url: 'https://x.example.test/' } })] })],
      ['stdio with auth', validManifest({
        services: [validService({
          connection: {
            type: 'stdio', command_ref: 'X_CMD',
            auth: { mechanism: 'oauth' } } })] })],
      ['api-key without credential_ref', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x.example.test/',
            auth: { mechanism: 'api-key' } } })] })],
      ['oauth with credential_ref', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x.example.test/',
            auth: { mechanism: 'oauth', credential_ref: 'X_TOKEN' } } })] })],
      ['http url', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'http://x.example.test/' } })] })],
      ['userinfo url', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://u:p@x.example.test/' } })] })],
      ['query url', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x.example.test/mcp?api_key=x' } })] })],
      ['fragment url', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x.example.test/#f' } })] })],
      ['command_ref path', validManifest({
        services: [validService({
          connection: {
            type: 'stdio', command_ref: '/home/x/mcp' } })] })],
      ['command_ref command line', validManifest({
        services: [validService({
          connection: {
            type: 'stdio', command_ref: 'npx -y server' } })] })],
      ['absolute local_config_ref', validManifest({
        services: [validService({
          connection: {
            type: 'remote', local_config_ref: '/etc/x.toml' } })] })],
      ['drive local_config_ref', validManifest({
        services: [validService({
          connection: {
            type: 'remote', local_config_ref: 'C:\\x\\y.toml' } })] })],
      ['id trailing newline', validManifest({
        services: [validService({ id: 'example\n' })] })],
      ['workflow trailing newline', validManifest({
        services: [validService({ workflows: ['deliver-issue\n'] })] })],
      ['credential_ref trailing newline', validManifest({
        services: [validService({ credential_refs: ['TRACKER_API_TOKEN\n'] })] })],
      ['command_ref trailing newline', validManifest({
        services: [validService({
          connection: {
            type: 'stdio', command_ref: 'LINT_MCP_COMMAND\n' } })] })],
      ['local_config_ref tab', validManifest({
        services: [validService({
          connection: {
            type: 'remote', local_config_ref: 'notes\tprofile' } })] })],
      ['local_config_ref null byte', validManifest({
        services: [validService({
          connection: {
            type: 'remote', local_config_ref: 'notes\x00profile' } })] })],
      ['url empty query', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x.test/mcp?' } })] })],
      ['url empty fragment', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x.test/mcp#' } })] })],
      ['url empty userinfo', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://@x.test/mcp' } })] })],
      ['url bracketed authority', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://[broken/mcp' } })] })],
      ['url ipv6 literal', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://[::1]:8443/mcp' } })] })],
      ['url missing hostname', validManifest({
        services: [validService({
          connection: { type: 'remote', url: 'https://:' } })] })],
      ['url double port', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x.test:8443:9/mcp' } })] })],
      ['url empty second port', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x.test::/mcp' } })] })],
      ['url tab host', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://\t/mcp' } })] })],
      ['url tab host with port', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://\t:0/mcp' } })] })],
      ['url nfkc slash authority', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://℀/mcp' } })] })],
      ['url fullwidth colon', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x：test/mcp' } })] })],
      ['url idn hostname', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://ä.example.test/mcp' } })] })],
      ['url empty label', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x..test/mcp' } })] })],
      ['url leading underscore label', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://_x.test/mcp' } })] })],
      ['url non-numeric port', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x.test:abc/mcp' } })] })],
      ['url kelvin sign host', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://\u212a.test/mcp' } })] })],
      ['url terminal newline no path', validManifest({
        services: [validService({
          connection: { type: 'remote', url: 'https://x\n' } })] })],
      ['url terminal newline with port', validManifest({
        services: [validService({
          connection: { type: 'remote', url: 'https://x:0\n' } })] })],
      ['purpose file-separator only', validManifest({
        services: [validService({ purpose: '\u001c' })] })],
      ['purpose feff only', validManifest({
        services: [validService({ purpose: '\ufeff' })] })],
    ];
    for (const [label, manifest] of cases) {
      const [schemaValid, tsValid] = verdicts(manifest);
      assert.equal(schemaValid, false, `${label}: schema accepted it`);
      assert.equal(tsValid, false, `${label}: TypeScript accepted it`);
    }
  });

  test('test_json_semantics_inputs_agree', () => {
    // JSON cannot distinguish 1 from 1.0; '@' in a URL path is
    // harmless; an empty port keeps the hostname; U+2028 in a
    // descriptive reference is prose, not a control character. Both
    // validators must accept these.
    const cases: [string, unknown][] = [
      ['float version', { version: 1.0, services: [validService()] }],
      ['at in url path', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x.test/a@b' } })] })],
      ['empty url port', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x.test:' } })] })],
      ['line-separator local_config_ref', validManifest({
        services: [validService({
          connection: {
            type: 'remote', local_config_ref: 'notes\u2028profile' } })] })],
      // U+16A0 (Runic) and U+1E00 (Latin) are real letters that fall
      // numerically between the Ogham space mark and U+200A; they must
      // stay valid prose in both validators.
      ['runic purpose', validManifest({
        services: [validService({ purpose: '\u16a0' })] })],
      ['latin purpose', validManifest({
        services: [validService({ purpose: '\u1e00' })] })],
      ['url with port', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x.test:8443/mcp' } })] })],
      ['url punycode host', validManifest({
        services: [validService({
          connection: {
            type: 'remote',
            url: 'https://xn--bcher-kva.example/mcp' } })] })],
      ['url localhost port', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://localhost:8443/mcp' } })] })],
      ['url underscore label', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x_y.test/mcp' } })] })],
      ['url newline inside path', validManifest({
        services: [validService({
          connection: {
            type: 'remote', url: 'https://x.test/m\ncp' } })] })],
    ];
    for (const [label, manifest] of cases) {
      const [schemaValid, tsValid] = verdicts(manifest);
      assert.ok(schemaValid, label);
      assert.ok(tsValid, label);
    }
  });

  test('test_python_only_checks_are_schema_valid_but_rejected', () => {
    const cases: [string, unknown][] = [
      ['duplicate id', validManifest({
        services: [
          validService(),
          validService({ guidance: ['docs/integrations.md'] }),
        ] })],
      ['unresolved guidance', validManifest({
        services: [validService({ guidance: ['docs/definitely-missing.md'] })] })],
      ['absolute guidance', validManifest({
        services: [validService({ guidance: ['/etc/passwd'] })] })],
    ];
    for (const [label, manifest] of cases) {
      const [schemaValid, tsValid] = verdicts(manifest);
      assert.ok(schemaValid, label);
      assert.equal(tsValid, false, label);
    }
  });
});

