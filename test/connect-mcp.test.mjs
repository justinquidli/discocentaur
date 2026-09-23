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
