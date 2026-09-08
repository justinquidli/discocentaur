/**
 * DiscoCentaur's first tests. Scope is deliberately narrow: the gate that
 * decides which Connect MCP tools the model is allowed to see, and the drop
 * recipient enum that has drifted from the server once already.
 *
 *   npm test
 *
 * bot.js connects to Discord on import, so these extract the functions under
 * test from its source rather than importing it — same approach as TeleCentaur.
 * Replace `grab()` with real imports when bot.js is split into modules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bot.js'), 'utf8');
const grab = (name) => {
  const m = SRC.match(new RegExp(`^(?:async )?function ${name}[\\s\\S]*?\\n}`, 'm'));
  if (!m) throw new Error(`Could not find function ${name} in bot.js — was it renamed?`);
  return m[0];
};
const build = (body, ret, args = {}) =>
  new Function(...Object.keys(args), `${body}\nreturn ${ret};`)(...Object.values(args));

const buildSelect = () => {
  const legacy = SRC.match(/^const MCP_LEGACY_ALLOWLIST = new Set\(\[[^\]]*\]\);$/m)[0];
  return build(`${legacy}\n${grab('selectMcpTools')}`, 'selectMcpTools');
};

test('read-only tools auto-register and connect_drop never does', () => {
  const selectMcpTools = buildSelect();
  const { register, skipped, annotated } = selectMcpTools([
    { name: 'connect_lookup', annotations: { readOnlyHint: true } },
    { name: 'connect_get_chains', annotations: { readOnlyHint: true } },
    { name: 'connect_drop_balance', annotations: { readOnlyHint: true } },
    { name: 'connect_drop', annotations: { readOnlyHint: false, destructiveHint: true } },
  ]);

  assert.equal(annotated, true);
  assert.deepEqual(skipped, ['connect_drop'], 'the money path must never be offered');
  assert.ok(register.map((t) => t.name).includes('connect_get_chains'));
  assert.equal(register.length, 3);
});

test('an unannotated tool from an annotating server is withheld', () => {
  const selectMcpTools = buildSelect();
  const { register, skipped } = selectMcpTools([
    { name: 'connect_lookup', annotations: { readOnlyHint: true } },
    { name: 'connect_execute' },
    { name: 'connect_settle', annotations: {} },
  ]);

  assert.deepEqual(register.map((t) => t.name), ['connect_lookup']);
  assert.deepEqual(skipped, ['connect_execute', 'connect_settle']);
});

test('a server with no annotations falls back to the legacy allowlist', () => {
  const selectMcpTools = buildSelect();
  const { register, skipped, annotated } = selectMcpTools([
    { name: 'connect_lookup' },
    { name: 'connect_me' },
    { name: 'connect_drop' },
    { name: 'connect_get_chains' },
  ]);

  assert.equal(annotated, false);
  assert.deepEqual(register.map((t) => t.name), ['connect_lookup', 'connect_me']);
  assert.ok(skipped.includes('connect_drop'));
  assert.ok(skipped.includes('connect_get_chains'), 'unknown tools stay out until annotated');
});

test('selectMcpTools survives a malformed tools/list', () => {
  const selectMcpTools = buildSelect();
  assert.deepEqual(selectMcpTools(undefined).register, []);
  assert.deepEqual(selectMcpTools([null, {}, { name: '' }]).register, []);
});

test('the drop recipient enum matches the platforms Connect resolves', () => {
  // Drifted silently once already: connect_lookup accepted slack while the
  // hand-written drop schema did not.
  const platforms = SRC.match(/^      enum: \[([^\]]*)\],$/m)[1]
    .split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);

  for (const p of ['discord', 'email', 'phone', 'twitter', 'telegram', 'farcaster', 'github', 'linkedin', 'slack']) {
    assert.ok(platforms.includes(p), `RECIPIENT_SCHEMA is missing ${p}`);
  }
});

test('a keyless call omits the api-key header entirely', async () => {
  // A header the server cannot verify — including the literal "undefined" a
  // missing value stringifies to — is a 401, so the public tools would fail for
  // exactly the users who have no key. No header is not a bad header.
  const seen = [];
  const env = build(
    ['const MCP_URL = "https://mcp.example/";', grab('mcpRpc')].join('\n'),
    'mcpRpc',
    { fetch: async (_url, init) => {
        seen.push(init.headers);
        return { ok: true, json: async () => ({ result: { tools: [] } }) };
      },
      AbortController, setTimeout, clearTimeout },
  );

  await env('tools/list', {}, null);
  await env('tools/list', {}, 'real-key');

  assert.equal('x-api-key' in seen[0], false, 'no key must mean no header');
  assert.equal(seen[1]['x-api-key'], 'real-key');
});

test('only auth and quota failures are turned into user-facing advice', () => {
  const mcpFailureReason = build(
    [SRC.match(/^const MCP_AUTH_ERROR_RE = .*$/m)[0],
     SRC.match(/^const MCP_QUOTA_ERROR_RE = .*$/m)[0],
     grab('mcpFailureReason')].join('\n'),
    'mcpFailureReason',
  );

  assert.equal(mcpFailureReason(new Error('MCP tools/call HTTP 401: no key')), 'auth');
  assert.equal(mcpFailureReason(new Error('Unauthorized')), 'auth');
  assert.equal(mcpFailureReason(new Error('MCP tools/call HTTP 429: slow down')), 'quota');
  assert.equal(mcpFailureReason(new Error('rate limit exceeded')), 'quota');
  // Anything else must keep throwing — swallowing a 500 as "get a key" would
  // send the user chasing the wrong problem.
  assert.equal(mcpFailureReason(new Error('MCP tools/call HTTP 500: upstream down')), null);
  assert.equal(mcpFailureReason(new Error('The operation was aborted')), null);
  assert.equal(mcpFailureReason(undefined), null);
});

// ── multi-chain explorer links ────────────────────────────────────────────────
// The bot was confined to Base because every link it produced was a basescan
// link, so a transfer on another chain would be reported with a URL that does
// not resolve. quidliDrop now attaches the right link for the chain it used.
test('explorer links follow the chain the drop was sent on', () => {
  const map = SRC.match(/^const CHAIN_EXPLORERS = \{[\s\S]*?\n\};/m);
  assert.ok(map, 'CHAIN_EXPLORERS not found in bot.js');
  const url = new Function(`${map[0]}; ${grab('explorerTxUrl')}; return explorerTxUrl;`)();

  assert.equal(url(8453, '0xabc'), 'https://basescan.org/tx/0xabc');
  assert.equal(url(1399811149, '5xTr'), 'https://solscan.io/tx/5xTr');
  assert.equal(url('8453', '0xabc'), 'https://basescan.org/tx/0xabc', 'chainId may arrive as a string');
  assert.equal(url(999999, '0xabc'), null, 'unknown chains get no link rather than a wrong one');
  assert.equal(url(8453, undefined), null, 'no hash, no link');
});

test('quidli_drop no longer requires tokenContract, so native sends are expressible', () => {
  const m = SRC.match(/name: 'quidli_drop'[\s\S]*?required: \[([^\]]*)\]/);
  assert.ok(m, 'could not find quidli_drop required list');
  assert.ok(!m[1].includes('tokenContract'), 'tokenContract must be optional — native SOL and native ETH omit it');
});
