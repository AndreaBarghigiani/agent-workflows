/**
 * The parity drivers may rewrite only an embedded TOML diagnostic tail.
 * A successful warning that mentions those words stays byte-for-byte.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeToml } from './parity/toml_diagnostic.ts';

const SUCCESS =
  'global entry `basic_memory` in /etc/opencode/Invalid TOML document: config.json points to the same endpoint';

test('successful warning text that contains the diagnostic prefix stays', () => {
  assert.equal(normalizeToml(SUCCESS), SUCCESS);
});

test('semantic wrapper stays while the diagnostic tail collapses', () => {
  const typescript =
    'Unparseable .codex/config.toml: Invalid TOML document: trailing comma in an inline table (at line 1, column 22); preserve and review';
  const python =
    'Unparseable .codex/config.toml: Invalid initial character for a key part (at line 1, column 22); preserve and review';
  const expected =
    'Unparseable .codex/config.toml:<toml>; preserve and review';
  assert.equal(normalizeToml(typescript), expected);
  assert.equal(normalizeToml(python), expected);
});

test('a wrapper with no diagnostic location stays', () => {
  const text = 'Unparseable .codex/config.toml; preserve and review';
  assert.equal(normalizeToml(text), text);
});
