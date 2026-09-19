import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseRepo, payoutProposal, payoutExecute } from '../payout-proposal.js';

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
