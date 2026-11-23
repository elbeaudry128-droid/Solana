import test from 'node:test';
import assert from 'node:assert/strict';
import { Excavator, evaluateTokenReport } from '../dist/core/excavator.js';

const mint = 'test-mint';
const valid = () => ({ mint, score: 42, risks: [], token: { mintAuthority: null, freezeAuthority: null } });

test('un rapport complet sans danger satisfait les critères configurés', () => {
  assert.equal(evaluateTokenReport(valid(), mint).isSafe, true);
});

test('un rapport absent, incomplet ou associé à un autre mint est refusé', () => {
  for (const data of [null, {}, { ...valid(), mint: 'autre' }, { ...valid(), score: undefined },
    { ...valid(), score: NaN }, { ...valid(), risks: undefined }, { ...valid(), token: {} },
    { ...valid(), token: { mintAuthority: null } }]) {
    assert.equal(evaluateTokenReport(data, mint).isSafe, false);
  }
});

test('les autorités actives, les risques dangereux et un score élevé sont refusés', () => {
  const reports = [
    { ...valid(), token: { mintAuthority: 'active', freezeAuthority: null } },
    { ...valid(), token: { mintAuthority: null, freezeAuthority: 'active' } },
    { ...valid(), risks: [{ name: 'problème', level: 'danger' }] },
    { ...valid(), risks: [{ name: 'inconnu', level: 'other' }] },
    { ...valid(), risks: [{ name: 'incomplet' }] },
    { ...valid(), score: 1000 },
  ];
  for (const report of reports) assert.equal(evaluateTokenReport(report, mint).isSafe, false);
});

test('une erreur API bloque la décision et le rapport complet est demandé', async () => {
  let requested = '';
  const excavator = new Excavator(async url => { requested = url; throw new Error('hors ligne'); });
  assert.equal((await excavator.analyzeToken(mint)).isSafe, false);
  assert.match(requested, /\/report$/);
  assert.doesNotMatch(requested, /summary/);
});
