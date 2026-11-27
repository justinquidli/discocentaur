// DEFAULT_CHAIN picks the chain for sends that don't name one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDefaultChain, defaultChainPrompt, defaultChainWarning, CHAINS, SOLANA_CHAIN_ID } from '../default-chain.js';

test('Base unless set; any known chain by name, alias or chain ID', () => {
  assert.equal(parseDefaultChain(undefined).chain.id, 8453);
  assert.equal(parseDefaultChain('').chain.id, 8453);
  assert.equal(parseDefaultChain('Solana').chain.id, SOLANA_CHAIN_ID);
  assert.equal(parseDefaultChain(' 1399811149 ').chain.id, SOLANA_CHAIN_ID);
  assert.equal(parseDefaultChain('arbitrum').chain.id, 42161);
  assert.equal(parseDefaultChain('Arbitrum One').chain.id, 42161);
  assert.equal(parseDefaultChain('op').chain.id, 10);
  assert.equal(parseDefaultChain('World Chain').chain.id, 480);
  assert.equal(parseDefaultChain('137').chain.id, 137);
  assert.equal(parseDefaultChain('base').warning, null);
});

test('an unknown chain falls back to Base with a warning, never stops the bot', () => {
  const r = parseDefaultChain('dogechain');
  assert.equal(r.chain.id, 8453);
  assert.match(r.warning, /dogechain.*using Base/);
});

test('every chain has a name, ID and native token; USDC addresses look right', () => {
  for (const c of Object.values(CHAINS)) {
    assert.ok(c.id && c.name && c.native, c.name);
    if (c.usdc) assert.match(c.usdc, c.id === SOLANA_CHAIN_ID ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-fA-F]{40}$/, c.name);
  }
  assert.equal(new Set(Object.values(CHAINS).map((c) => c.id)).size, Object.keys(CHAINS).length, 'no duplicate IDs');
});

test('the prompt names the default chain, its USDC and who pays gas', () => {
  const sol = defaultChainPrompt(CHAINS.solana);
  assert.match(sol, /use Solana \(chainId 1399811149\)/);
  assert.match(sol, /EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/);
  assert.match(sol, /pays a small network fee in SOL/);
  assert.match(sol, /Base 0x833589/);
  assert.match(defaultChainPrompt(CHAINS.base), /use Base \(chainId 8453\)[\s\S]*sponsored/);
  const arb = defaultChainPrompt(CHAINS.arbitrum);
  assert.match(arb, /tokenContract=0xaf88d065e77c8cC2239327C5EDb3A432268e5831/);
  assert.match(arb, /pays gas in ETH/);
  assert.doesNotMatch(arb.split('USDC on other chains')[1].split('\n')[0], /Arbitrum/, 'the default is not repeated as an "other" chain');
});

test('a chain without a verified USDC address: ask, never guess', () => {
  assert.match(defaultChainPrompt(CHAINS.robinhood), /No USDC address is known for Robinhood Chain.*ask the user.*Never guess/);
  assert.match(defaultChainPrompt(CHAINS.arc), /USDC is the native token: leave tokenContract out/);
  assert.match(defaultChainPrompt(CHAINS.arc), /gas is paid in USDC/);
});

test('startup warns when Connect does not send on the default chain', () => {
  const live = [{ chainId: 8453, features: { drop: true } }, { chainId: 137, features: { drop: false } }];
  assert.equal(defaultChainWarning(CHAINS.base, live), null);
  assert.match(defaultChainWarning(CHAINS.polygon, live), /Polygon.*doesn't send on it/);
  assert.match(defaultChainWarning(CHAINS.celo, live), /Celo/);
  assert.equal(defaultChainWarning(CHAINS.celo, null), null, 'no list, no warning');
});
