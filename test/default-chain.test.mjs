// DEFAULT_CHAIN picks the chain for sends that don't name one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDefaultChain, defaultChainPrompt, CHAINS, SOLANA_CHAIN_ID } from '../default-chain.js';

test('Base unless set; solana by name or chain ID', () => {
  assert.equal(parseDefaultChain(undefined).chain.id, 8453);
  assert.equal(parseDefaultChain('').chain.id, 8453);
  assert.equal(parseDefaultChain('Solana').chain.id, SOLANA_CHAIN_ID);
  assert.equal(parseDefaultChain(' 1399811149 ').chain.id, SOLANA_CHAIN_ID);
  assert.equal(parseDefaultChain('base').warning, null);
});

test('an unknown chain falls back to Base with a warning, never stops the bot', () => {
  const r = parseDefaultChain('polygon');
  assert.equal(r.chain.id, 8453);
  assert.match(r.warning, /polygon.*base or solana/);
});

test('the prompt names the default chain, its USDC and who pays gas', () => {
  const sol = defaultChainPrompt(CHAINS.solana);
  assert.match(sol, /use Solana \(chainId 1399811149\)/);
  assert.match(sol, /EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/);
  assert.match(sol, /pays a small network fee in SOL/);
  assert.match(sol, /USDC on Base, only when the user asks for Base: tokenContract=0x833589/);
  const base = defaultChainPrompt(CHAINS.base);
  assert.match(base, /use Base \(chainId 8453\)/);
  assert.match(base, /sponsored/);
});
