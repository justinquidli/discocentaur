// A bare confirm / cancel acts on the only waiting transfer; with several it lists them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('bare confirm picks the single waiting transfer', () => {
  const bot = readFileSync(new URL('../bot.js', import.meta.url), 'utf8');
  assert.match(bot, /if \(mine\.length === 1\) code = mine\[0\]\.code;/);
});

test('the prompt tells the model not to ask before a repeat; the bot holds it', () => {
  assert.match(readFileSync(new URL('../bot.js', import.meta.url), 'utf8'), /don't ask whether to send again: call connect_drop as asked/);
});
