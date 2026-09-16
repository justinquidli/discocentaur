#!/usr/bin/env node
// Copy the shared files from THIS repo to the other bot's repo.
// Usage: npm run sync-shared            (sibling found next to this repo)
//        SHARED_SIBLING=/path npm run sync-shared
// Shows what differs and asks nothing — run it from the repo whose version is right,
// then review `git diff` in the other repo before committing.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED_FILES } from './shared-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const self = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
const candidates = process.env.SHARED_SIBLING
  ? [process.env.SHARED_SIBLING]
  : self === 'telecentaur' ? ['../discocentaur', '../claudetaur'] : ['../telecentaur'];
const sibling = candidates.map((c) => resolve(root, c)).find((p) => existsSync(join(p, 'package.json')));
if (!sibling) { console.error(`other repo not found (looked in ${candidates.join(', ')}); set SHARED_SIBLING`); process.exit(1); }

let changed = 0;
for (const f of SHARED_FILES) {
  const src = join(root, f), dst = join(sibling, f);
  const same = existsSync(dst) && readFileSync(src).equals(readFileSync(dst));
  if (same) continue;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`copied ${f} → ${dst}`);
  changed++;
}
console.log(changed ? `${changed} file(s) updated in ${sibling}. Review with git diff there, then commit.` : `Already in sync with ${sibling}.`);
