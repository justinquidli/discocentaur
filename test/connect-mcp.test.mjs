/**
 * The Connect MCP gate and the live tool registry. Shared byte-for-byte with
 * the other bot (see scripts/shared-files.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectMcpTools, createMcpRegistry, MCP_CONFIRM_TOOLS, MCP_LEGACY_ALLOWLIST,
} from '../connect-mcp.js';

const ro = (name, extra = {}) => ({ name, description: `${name} v1`, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, ...extra });
const rw = (name) => ({ name, description: name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } });
const quiet = { log: () => {}, error: () => {} };

// ── selectMcpTools ───────────────────────────────────────────────────────────

test('connect_drop can never be made confirmable', () => {
  assert.equal(MCP_CONFIRM_TOOLS.has('connect_drop'), false, 'connect_drop is a send tool, not a confirm tool');
});

test('write tools are withheld unless named as confirm or send tools', () => {
  const { register, skipped } = selectMcpTools([
    ro('connect_lookup'),
    rw('connect_drop'),
    rw('connect_trust_create'),
    rw('connect_trust_revoke'),
    rw('connect_something_new'),
  ]);
  assert.deepEqual(register.map((t) => t.name), ['connect_lookup', 'connect_drop', 'connect_trust_create', 'connect_trust_revoke']);
  assert.deepEqual(skipped, ['connect_something_new'], 'any other new write tool stays out');
});

test('a confirmable name without readOnlyHint:false is still withheld', () => {
  const { register } = selectMcpTools([ro('connect_lookup'), { name: 'connect_trust_create', annotations: {} }]);
  assert.deepEqual(register.map((t) => t.name), ['connect_lookup']);
});

test('legacy fallback never offers a confirmable write tool', () => {
  const { register, annotated } = selectMcpTools([{ name: 'connect_lookup' }, { name: 'connect_trust_create' }]);
  assert.equal(annotated, false);
  assert.deepEqual(register.map((t) => t.name), ['connect_lookup']);
  assert.ok([...MCP_LEGACY_ALLOWLIST].every((n) => !MCP_CONFIRM_TOOLS.has(n)));
});

// ── createMcpRegistry ────────────────────────────────────────────────────────

function setup(responses) {
  const tools = [{ name: 'schedule_drop', description: 'local', input_schema: {} }];
  let i = 0;
  let listCalls = 0;
  const listTools = async () => {
    listCalls++;
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return { tools: r };
  };
  const reg = createMcpRegistry({ tools, listTools, logger: quiet });
  return { tools, reg, listCalls: () => listCalls };
}

const toolNames = (tools) => tools.map((t) => t.name);

test('first refresh registers the allowed tools next to the hardcoded ones', async () => {
  const { tools, reg } = setup([[ro('connect_lookup'), rw('connect_drop'), rw('connect_settle')]]);
  const r = await reg.refresh();
  assert.equal(r.ok, true);
  assert.deepEqual(toolNames(tools), ['schedule_drop', 'connect_lookup', 'connect_drop']);
  assert.deepEqual([...reg.names], ['connect_lookup', 'connect_drop']);
});

test('a new tool appears, a retired one goes, without a restart', async () => {
  const { tools, reg } = setup([
    [ro('connect_lookup'), ro('connect_me')],
    [ro('connect_lookup'), ro('connect_trust_graph')],
  ]);
  const namesRef = reg.names;
  await reg.refresh();
  const r = await reg.refresh();
  assert.deepEqual(r.added, ['connect_trust_graph']);
  assert.deepEqual(r.removed, ['connect_me']);
  assert.deepEqual(toolNames(tools).sort(), ['connect_lookup', 'connect_trust_graph', 'schedule_drop']);
  assert.equal(reg.names, namesRef, 'the set the dispatcher holds is mutated in place');
  assert.ok(reg.names.has('connect_trust_graph') && !reg.names.has('connect_me'));
});

test('a changed schema or description is swapped in', async () => {
  const { tools, reg } = setup([
    [ro('connect_lookup')],
    [ro('connect_lookup', { description: 'connect_lookup v2' })],
  ]);
  await reg.refresh();
  const r = await reg.refresh();
  assert.deepEqual(r.changed, ['connect_lookup']);
  assert.equal(tools.find((t) => t.name === 'connect_lookup').description, 'connect_lookup v2');
  assert.equal(tools.filter((t) => t.name === 'connect_lookup').length, 1, 'no duplicate entries');
});

test('an unchanged list leaves the array untouched', async () => {
  const { tools, reg } = setup([[ro('connect_lookup')], [ro('connect_lookup')]]);
  await reg.refresh();
  const before = tools[1];
  const r = await reg.refresh();
  assert.deepEqual([r.added, r.removed, r.changed], [[], [], []]);
  assert.equal(tools[1], before);
});

test('a failed or empty tools/list keeps the last good set', async () => {
  const { tools, reg } = setup([[ro('connect_lookup')], new Error('HTTP 502'), []]);
  await reg.refresh();
  assert.equal((await reg.refresh()).ok, false);
  assert.equal((await reg.refresh()).ok, false);
  assert.deepEqual(toolNames(tools), ['schedule_drop', 'connect_lookup']);
  assert.ok(reg.names.has('connect_lookup'));
});

test('an MCP tool cannot shadow a hardcoded tool', async () => {
  const { tools, reg } = setup([[ro('schedule_drop'), ro('connect_lookup')]]);
  await reg.refresh();
  assert.deepEqual(toolNames(tools), ['schedule_drop', 'connect_lookup']);
  assert.equal(tools[0].description, 'local');
  assert.equal(reg.names.has('schedule_drop'), false);
});

test('overlapping refreshes share one tools/list call', async () => {
  const { reg, listCalls } = setup([[ro('connect_lookup')]]);
  await Promise.all([reg.refresh(), reg.refresh(), reg.refresh()]);
  assert.equal(listCalls(), 1);
});

// ── plain types for the model (2026-09-23: a free model sent USDC's address as
// 7.49e+47 through tokenContract: ["string","null"]) ─────────────────────────

import { plainSchema } from '../connect-mcp.js';

test('unions the model misreads become plain types; nothing else changes', () => {
  const live = {
    type: 'object',
    properties: {
      tokenContract: { type: ['string', 'null'], description: 'mint' },
      amountInWeiPerRecipient: { anyOf: [{ anyOf: [{ not: {} }, { type: 'string' }] }, { type: 'null' }], description: 'amt' },
      chainId: { type: 'integer' },
      recipients: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['discord', 'wallet'] } } } },
      either: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    },
    required: ['chainId'],
  };
  const p = plainSchema(live);
  assert.deepEqual(p.properties.tokenContract, { type: 'string', description: 'mint' });
  assert.deepEqual(p.properties.amountInWeiPerRecipient, { type: 'string', description: 'amt' });
  assert.deepEqual(p.properties.chainId, { type: 'integer' });
  assert.deepEqual(p.properties.recipients, live.properties.recipients);
  assert.equal(p.properties.either.anyOf.length, 2, 'a real choice between types is kept');
  assert.deepEqual(p.required, ['chainId']);
  assert.equal(live.properties.tokenContract.type.length, 2, 'the input is not mutated');
});

test('registered tools are shown with plain types', async () => {
  const { tools, reg } = setup([[{ ...rw('connect_drop'), inputSchema: { type: 'object', properties: { tokenContract: { type: ['string', 'null'] } } } }]]);
  await reg.refresh();
  assert.equal(tools.find((t) => t.name === 'connect_drop').input_schema.properties.tokenContract.type, 'string');
});

test('the model is not shown connect_drop\'s idempotencyKey; other tools are unchanged', async () => {
  const schema = { type: 'object', properties: { idempotencyKey: { type: 'string' }, chainId: { type: 'integer' } }, required: ['idempotencyKey', 'chainId'] };
  const { tools, reg } = setup([[{ ...rw('connect_drop'), inputSchema: schema }, { ...ro('connect_lookup'), inputSchema: schema }]]);
  await reg.refresh();
  const drop = tools.find((t) => t.name === 'connect_drop').input_schema;
  assert.deepEqual(drop, { type: 'object', properties: { chainId: { type: 'integer' } }, required: ['chainId'] });
  assert.deepEqual(tools.find((t) => t.name === 'connect_lookup').input_schema, schema);
});
