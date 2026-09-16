/**
 * TeleCentaur and DiscoCentaur are separate apps, but these files hold
 * platform-neutral money logic and must be byte-identical in both repos.
 * Change them in one repo, then run `npm run sync-shared` to copy them over.
 *
 * Looks for the other repo next to this one (../discocentaur or ../claudetaur
 * for DiscoCentaur, ../telecentaur for TeleCentaur), or at SHARED_SIBLING.
 * If it isn't there (e.g. CI with one repo), the test is skipped, not passed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SHARED_FILES } from '../scripts/shared-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const self = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
const candidates = process.env.SHARED_SIBLING
  ? [process.env.SHARED_SIBLING]
  : self === 'telecentaur' ? ['../discocentaur', '../claudetaur'] : ['../telecentaur'];
const sibling = candidates.map((c) => resolve(root, c)).find((p) => existsSync(join(p, 'bankr.js')));

const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);

test('shared files match the other bot', { skip: sibling ? false : `other repo not found (looked in ${candidates.join(', ')}); set SHARED_SIBLING` }, () => {
  const drift = SHARED_FILES.filter((f) => {
    const a = join(root, f), b = join(sibling, f);
    return !existsSync(a) || !existsSync(b) || hash(a) !== hash(b);
  });
  assert.deepEqual(drift, [], `Out of sync with ${sibling}: ${drift.join(', ')}. Run \`npm run sync-shared\` from the repo with the version you want.`);
});
