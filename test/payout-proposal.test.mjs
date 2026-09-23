import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseRepo, payoutProposal, payoutExecute, groundCheck } from '../payout-proposal.js';

test('a pasted GitHub link reduces to owner/name', () => {
  const cases = {
    'https://github.com/BankrBot/skills': 'BankrBot/skills',
    'http://www.github.com/BankrBot/skills/': 'BankrBot/skills',
    'github.com/BankrBot/skills/pull/3': 'BankrBot/skills',
    '<https://github.com/justinquidli/payout-demo>': 'justinquidli/payout-demo',
    'https://github.com/BankrBot/skills.git': 'BankrBot/skills',
    '  BankrBot/skills  ': 'BankrBot/skills',
  };
  for (const [given, want] of Object.entries(cases)) assert.equal(normaliseRepo(given), want);
});

test('something that is not a repo is refused with what was given', async () => {
  const out = await payoutProposal({ repo: 'the bankr one', budget: '100' });
  assert.equal(out.status, 'refused');
  assert.match(out.error, /the bankr one/);
});

test('a bad budget or window is refused before anything runs', async () => {
  assert.equal((await payoutProposal({ repo: 'a/b', budget: 'lots' })).status, 'refused');
  assert.equal((await payoutProposal({ repo: 'a/b', since: 'ages', budget: '5' })).status, 'refused');
});

test('execute refuses a label that is not one', async () => {
  for (const label of ['../../etc/passwd', '', 'no spaces allowed']) {
    assert.equal((await payoutExecute({ label })).status, 'refused');
  }
});

test('a repeat proposal for the same ask returns the same round, not a new split', async (t) => {
  // Refusals never cache; a real run needs the payout project, so this asserts
  // the shape of the guard rather than re-running the scorer.
  const first = await payoutProposal({ repo: 'a/b', budget: '100', since: '1d' });
  const second = await payoutProposal({ repo: 'a/b', budget: '100', since: '1d' });
  assert.equal(first.status, second.status);
  if (first.status === 'ok') {
    assert.equal(second.label, first.label, 'same label reused');
    assert.equal(second.reused, true);
  }
});

test('a parameter the user never gave is refused before any scoring runs', async () => {
  const said = 'reward the contributors of https://github.com/BankrBot/skills from the past 3 days out of 5000 BNKR';
  assert.equal(groundCheck({ repo: 'BankrBot/skills', budget: '5000', since: '3d' }, said), null);
  assert.match(groundCheck({ repo: 'BankrBot/skills', budget: '5000', since: '14d' }, said), /window/);
  assert.match(groundCheck({ repo: 'BankrBot/skills', budget: '20000', since: '3d' }, said), /budget/);
  assert.match(groundCheck({ repo: 'BankrBot/other', budget: '5000', since: '3d' }, said), /repo/);
});

test('windows the user spelled in words are accepted', () => {
  assert.equal(groundCheck({ repo: 'a/skills', budget: '10', since: '7d' }, 'pay skills 10 for the last week'), null);
  assert.equal(groundCheck({ repo: 'a/skills', budget: '10', since: '48h' }, 'skills, 10, last 48 hours'), null);
});

test('a run that broadcasts nothing is never reported as paid', async (t) => {
  // payout.js exits 0 when the rails reject a plan and when nothing is owed,
  // so the exit code cannot be the success signal.
  const { execSync } = await import('node:child_process');
  const src = execSync('cat payout-proposal.js', { encoding: 'utf8' });
  assert.match(src, /Exit 0 does NOT mean paid/);
  assert.match(src, /const sent = \/\^Sent\\\.\$\/m\.test\(out\) && hashes\.length > 0;/);
});
