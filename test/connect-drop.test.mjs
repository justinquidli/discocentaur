/**
 * The single send path (connect_drop over MCP) and the amount check.
 * Shared byte-for-byte with the other bot (see scripts/shared-files.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createConnectDrop, checkAmountGrounded, tokenInfo, formatUnits, parseUnits, numbersIn,
} from '../connect-drop.js';
import { selectMcpTools, modelFacingTool, MCP_WRAPPED_TOOLS, MCP_CONFIRM_TOOLS } from '../connect-mcp.js';

const quiet = { log: () => {}, error: () => {} };
const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const toolError = (text) => ({ isError: true, content: [{ type: 'text', text }] });

function harness(replies) {
  const calls = [];
  let i = 0;
  const rpc = async (method, params, apiKey) => {
    calls.push({ method, params, apiKey });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  let n = 0;
  const drop = createConnectDrop({ rpc, uuid: () => `key-${++n}`, wait: async () => {}, logger: quiet });
  return { drop, calls };
}

const args = { chainId: 8453, tokenContract: '0xusdc', recipients: [{ type: 'discord', id: '1' }], amountInWeiPerRecipient: '10000' };

// ── send ─────────────────────────────────────────────────────────────────────

test('a send calls connect_drop once with a bot-made key; the model cannot set one', async () => {
  const { drop, calls } = harness([ok({ httpStatus: 201, transferHash: '0xabc' })]);
  const r = await drop.send({ ...args, idempotencyKey: 'from-the-model', surprise: 1 }, 'k');
  assert.equal(r.status, 'submitted');
  assert.equal(r.transferHash, '0xabc');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.name, 'connect_drop');
  assert.equal(calls[0].params.arguments.idempotencyKey, 'key-1');
  assert.equal(calls[0].params.arguments.surprise, undefined, 'only known fields are forwarded');
  assert.equal(calls[0].apiKey, 'k');
});

test('timeouts and 5xx retry with the SAME key, so a retry can never be a second payment', async () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const { drop, calls } = harness([abort, toolError('Connect API error (502): Bad gateway'), ok({ httpStatus: 201, transferHash: '0xabc' })]);
  const r = await drop.send(args, 'k');
  assert.equal(r.status, 'submitted');
  assert.equal(calls.length, 3);
  assert.deepEqual(new Set(calls.map((c) => c.params.arguments.idempotencyKey)), new Set(['key-1']));
});

test('202 processing is retried with the same key', async () => {
  const { drop, calls } = harness([ok({ httpStatus: 202, status: 'processing' }), ok({ httpStatus: 201, transferHash: '0xabc' })]);
  const r = await drop.send(args, 'k');
  assert.equal(r.status, 'submitted');
  assert.equal(calls[0].params.arguments.idempotencyKey, calls[1].params.arguments.idempotencyKey);
});

test('uncertain on every attempt → unknown, and the message says do not send again', async () => {
  const { drop, calls } = harness([new Error('MCP tools/call HTTP 504: gateway timeout')]);
  const r = await drop.send(args, 'k');
  assert.equal(r.status, 'unknown');
  assert.equal(r.executed, 'unknown');
  assert.match(r.error, /MAY have gone through/);
  assert.match(r.error, /Do NOT send it again/);
  assert.equal(calls.length, 4);
});

test('a refusal from Connect is failed at once — no retry, nothing sent', async () => {
  const { drop, calls } = harness([toolError('Insufficient funds')]);
  const r = await drop.send(args, 'k');
  assert.equal(r.status, 'failed');
  assert.equal(r.executed, false);
  assert.match(r.error, /Insufficient funds/);
  assert.equal(calls.length, 1);
});

test('still processing after every attempt → failed with "not sent yet"', async () => {
  const { drop } = harness([ok({ httpStatus: 202, status: 'processing' })]);
  const r = await drop.send(args, 'k');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /had not sent anything/);
});

// ── MCP gating ───────────────────────────────────────────────────────────────

test('connect_drop is registered only as a wrapped tool, never as a confirm tool', () => {
  assert.ok(MCP_WRAPPED_TOOLS.has('connect_drop'));
  assert.equal(MCP_CONFIRM_TOOLS.has('connect_drop'), false);
  const { register } = selectMcpTools([
    { name: 'connect_drop', annotations: { readOnlyHint: false } },
    { name: 'connect_other_write', annotations: { readOnlyHint: false } },
  ]);
  assert.deepEqual(register.map((t) => t.name), ['connect_drop']);
});

test('the model never sees idempotencyKey in connect_drop', () => {
  const t = modelFacingTool({
    name: 'connect_drop', description: 'Execute a Smart Send.',
    inputSchema: { type: 'object', properties: { idempotencyKey: { type: 'string' }, chainId: { type: 'integer' } }, required: ['idempotencyKey', 'chainId'] },
  });
  assert.equal(t.input_schema.properties.idempotencyKey, undefined);
  assert.deepEqual(t.input_schema.required, ['chainId']);
  assert.match(t.description, /ONCE per request/);
  const other = modelFacingTool({ name: 'connect_lookup', description: 'x', inputSchema: { type: 'object' } });
  assert.equal(other.description, 'x');
});

// ── amounts ──────────────────────────────────────────────────────────────────

const balance = { assets: [
  { type: 'native', tokenContract: null, symbol: 'ETH', decimals: 18 },
  { type: 'erc20', tokenContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
  { type: 'erc20', tokenContract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
] };

test('tokenInfo finds native, EVM (any case) and Solana tokens; null when not held', () => {
  assert.deepEqual(tokenInfo(balance, null), { decimals: 18, symbol: 'ETH' });
  assert.deepEqual(tokenInfo(balance, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), { decimals: 6, symbol: 'USDC' });
  assert.deepEqual(tokenInfo(balance, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), { decimals: 6, symbol: 'USDC' });
  assert.equal(tokenInfo(balance, 'epjfwdd5aufqssqem2qn1xzybapc8g4wegggkzwytdt1v'), null, 'Solana mints are case-sensitive');
  assert.equal(tokenInfo(balance, '0xdead'), null);
});

test('units round-trip', () => {
  assert.equal(formatUnits('100000', 6), '0.1');
  assert.equal(formatUnits('53615001', 9), '0.053615001');
  assert.equal(formatUnits('1000000', 6), '1');
  assert.equal(parseUnits('0.01', 6), 10000n);
  assert.equal(parseUnits('0.0000001', 6), null, 'more precision than the token has');
  assert.deepEqual(numbersIn('send @Guillaume 0.01 USDC, then 1,000 DEGEN and 0,5 SOL or .25'), ['0.01', '1000', '0.5', '0.25']);
});

test('the real case: "0.01 USDC on base" sent as 100000 (0.1) is refused', () => {
  const r = checkAmountGrounded({ amounts: ['100000'], recipientCount: 1, decimals: 6, symbol: 'USDC', userText: '@DiscoCentaur, send @Guillaume 0.01 USDC on base, please' });
  assert.match(r, /nothing was sent/);
  assert.match(r, /0\.1 USDC per recipient/);
  assert.match(r, /only mentions 0\.01/);
});

test('the right amount passes', () => {
  assert.equal(checkAmountGrounded({ amounts: ['10000'], recipientCount: 1, decimals: 6, symbol: 'USDC', userText: 'send @Guillaume 0.01 USDC on base' }), null);
  assert.equal(checkAmountGrounded({ amounts: ['5000000000000000000'], recipientCount: 2, decimals: 18, symbol: 'DEGEN', userText: 'give 5 DEGEN each to a and b' }), null);
});

test('a total the user gave, split across recipients, passes', () => {
  assert.equal(checkAmountGrounded({ amounts: ['5000000'], recipientCount: 3, decimals: 6, symbol: 'USDC', userText: 'split 15 USDC between the three of them' }), null);
});

test('per-recipient amounts must each be stated, or sum to a stated total', () => {
  assert.equal(checkAmountGrounded({ amounts: ['1000000', '2000000'], recipientCount: 2, decimals: 6, symbol: 'USDC', userText: 'alice 1 USDC, bob 2 USDC' }), null);
  assert.equal(checkAmountGrounded({ amounts: ['1000000', '2000000'], recipientCount: 2, decimals: 6, symbol: 'USDC', userText: '3 USDC total, alice gets 1' }), null);
  assert.match(checkAmountGrounded({ amounts: ['1000000', '9000000'], recipientCount: 2, decimals: 6, symbol: 'USDC', userText: 'alice 1 USDC, bob 2 USDC' }), /nothing was sent/);
});

test('no number in the message → refused, and the model is told to ask', () => {
  const r = checkAmountGrounded({ amounts: ['10000'], recipientCount: 1, decimals: 6, symbol: 'USDC', userText: 'same again please' });
  assert.match(r, /gives no amount/);
  assert.match(r, /ask them/);
});

test('unknown recipient count (presence drops) checks the per-recipient amount only', () => {
  assert.equal(checkAmountGrounded({ amounts: ['1000000'], recipientCount: null, decimals: 6, symbol: 'USDC', userText: '1 USDC to everyone online' }), null);
  assert.match(checkAmountGrounded({ amounts: ['1000000'], recipientCount: null, decimals: 6, symbol: 'USDC', userText: '10 USDC split among everyone online' }), /nothing was sent/);
});
