// bot.js uses DEFAULT_CHAIN for sends that name no chain, and holds a repeated send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bot = readFileSync(new URL('../bot.js', import.meta.url), 'utf8');

test('no code path hard-codes Base as the default; the prompt gets the default-chain section', () => {
  assert.doesNotMatch(bot, /Base \(8453\) is the default|\?\? 8453|chainId = 8453/);
  assert.match(bot, /const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT \+ defaultChainPrompt\(DEFAULT_CHAIN_INFO\)/);
});

test('a repeated send is held, a real send is marked, a refused one released', () => {
  assert.match(bot, /holdWhy = 'repeat'/);
  assert.match(bot, /if \(body\?\.transferHash\) repeatGuard\.mark/);
  assert.match(bot, /repeatGuard\.release/);
  assert.match(readFileSync(new URL('../held-actions.js', import.meta.url), 'utf8'), /repeat: 'you just sent this same payment'/);
});
