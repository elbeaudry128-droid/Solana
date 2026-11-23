import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../dist/config.js';
import { createJupiterObservation, startRaydiumWithJupiter } from '../dist/core/jupiterBindings.js';

const mint = 'So11111111111111111111111111111111111111112';
const poolId = '11111111111111111111111111111111';
const makeLogger = () => {
  const entries = [];
  return {
    entries,
    info(data, message) { entries.push({ level: 'info', data, message }); },
    warn(data, message) { entries.push({ level: 'warn', data, message }); },
  };
};

test('l’observation Jupiter reste désactivée par défaut et en mode non observation', () => {
  const log = makeLogger();
  let calls = 0;
  const factory = () => { calls++; throw new Error('must not start'); };
  assert.equal(createJupiterObservation(loadConfig({}), log, { factory }), undefined);
  const config = { ...loadConfig({ JUPITER_TOKENS_ENABLED: 'true' }), dryRun: false };
  assert.equal(createJupiterObservation(config, log, { factory }), undefined);
  assert.equal(calls, 0);
});

test('la source recent et les résultats search sont réservés aux journaux', () => {
  const log = makeLogger();
  let handlers;
  let receivedOptions;
  const mockClient = {
    async recent() { throw new Error('network forbidden'); },
    async searchByMints() { throw new Error('network forbidden'); },
  };
  const handle = { start() {}, stop() {}, observeRaydium() {} };
  const config = loadConfig({ JUPITER_TOKENS_ENABLED: 'true', JUPITER_TOKENS_POLL_INTERVAL_MS: '7000' });
  const result = createJupiterObservation(config, log, {
    client: mockClient,
    factory(client, callbacks, options) {
      assert.equal(client, mockClient);
      handlers = callbacks;
      receivedOptions = options;
      return handle;
    },
  });
  assert.equal(result, handle);
  assert.equal(receivedOptions.pollIntervalMs, 7000);

  const token = { mint, firstPool: { id: poolId }, liquidityUsd: 100 };
  handlers.onRecent({ source: 'jupiter-recent', mint, poolId, baseline: true, observedAt: 100, token });
  handlers.onEnrichment({ source: 'raydium', enrichmentSource: 'jupiter-search', mint, poolId, observedAt: 101, status: 'found', token });
  handlers.onEnrichment({ source: 'raydium', enrichmentSource: 'jupiter-search', mint, poolId, observedAt: 102, status: 'unknown', reason: 'not_found' });
  handlers.onError({ source: 'jupiter-recent', mint: null, code: 'rate_limited' });

  assert.equal(log.entries.length, 4);
  assert.equal(log.entries[0].data.baseline, true);
  assert.equal(log.entries[0].data.source, 'jupiter-recent');
  assert.equal(log.entries[1].data.enrichmentSource, 'jupiter-search');
  assert.equal(log.entries[2].data.status, 'unknown');
  assert.equal(log.entries[3].data.code, 'rate_limited');
  assert.match(log.entries[0].message, /sans garantie de sécurité/);
});

test('Raydium continue à traiter le pool même si Jupiter ne peut pas le mettre en file', async () => {
  const calls = [];
  let callback;
  const monitor = { async start(cb) { calls.push('monitor-start'); callback = cb; } };
  const observer = {
    start() { calls.push('observer-start'); },
    stop() { calls.push('observer-stop'); },
    observeRaydium(m, p) { calls.push(['enqueue', m, p]); throw new Error('simulated failure'); },
  };
  await startRaydiumWithJupiter(monitor, async (m, p) => calls.push(['pool', m, p]), observer, () => calls.push('warning'));
  await callback(mint, poolId);
  assert.deepEqual(calls, ['observer-start', 'monitor-start', ['enqueue', mint, poolId], 'warning', ['pool', mint, poolId]]);
});

test('sans Jupiter le callback Raydium existant reste inchangé', async () => {
  let callback;
  const results = [];
  await startRaydiumWithJupiter({ async start(cb) { callback = cb; } }, (m, p) => results.push([m, p]), undefined, () => assert.fail('unexpected warning'));
  await callback(mint, poolId);
  assert.deepEqual(results, [[mint, poolId]]);
});

test('une erreur du logger Jupiter ne bloque pas le callback Raydium', async () => {
  let callback;
  const pools = [];
  const observer = { start() {}, stop() {}, observeRaydium() { throw new Error('enqueue'); } };
  await startRaydiumWithJupiter({ async start(cb) { callback = cb; } }, (m, p) => pools.push([m, p]), observer,
    () => { throw new Error('logging failed'); });
  await callback(mint, poolId);
  assert.deepEqual(pools, [[mint, poolId]]);
});

test('un échec de souscription RPC arrête le polling Jupiter', async () => {
  const calls = [];
  const observer = { start() { calls.push('start'); }, stop() { calls.push('stop'); }, observeRaydium() {} };
  await assert.rejects(startRaydiumWithJupiter({ async start() { throw new Error('RPC failure'); } }, () => {}, observer, () => {}), /RPC failure/);
  assert.deepEqual(calls, ['start', 'stop']);
});


test('intégration compilée : recent journalise séparément et search enrichit un pool Raydium', async () => {
  const { JupiterTokensClient } = await import('../dist/core/jupiterTokens.js');
  const { JupiterObservation } = await import('../dist/core/jupiterObservation.js');
  const log = makeLogger();
  const calls = [];
  const pools = [];
  const recentMint = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const key = 'TEST_ONLY_FAKE_JUPITER_KEY';
  const client = new JupiterTokensClient({ apiKey: key, transport: async request => {
    const url = new URL(request.url);
    calls.push(url.pathname);
    assert.equal(request.headers['x-api-key'], key);
    if (url.pathname.endsWith('/recent')) return { status: 200, data: JSON.stringify([{ id: recentMint }]) };
    assert.equal(url.searchParams.get('query'), mint);
    return { status: 200, data: JSON.stringify([{ id: mint, liquidity: 42 }]) };
  } });
  const timers = new Map();
  let timerId = 0;
  const clock = {
    now: () => 0,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async runDue() {
      for (let i = 0; i < 50; i++) {
        for (let j = 0; j < 30; j++) await Promise.resolve();
        const next = [...timers.entries()].find(([, timer]) => timer.delay === 0);
        if (!next) return;
        timers.delete(next[0]);
        next[1].fn();
      }
      throw new Error('simulated timer runaway');
    },
  };
  const config = loadConfig({ JUPITER_TOKENS_ENABLED: 'true' });
  const observer = createJupiterObservation(config, log, {
    client,
    factory: (c, handlers, options) => new JupiterObservation(c, handlers, { ...options, ...clock }),
  });
  let callback;
  await startRaydiumWithJupiter({ async start(cb) { callback = cb; } }, (m, p) => pools.push([m, p]), observer, () => assert.fail('unexpected warning'));
  await clock.runDue();
  assert.deepEqual(pools, [], 'recent ne déclenche pas le chemin Raydium');
  assert.deepEqual(calls, ['/tokens/v2/recent']);
  assert.equal(log.entries[0].data.source, 'jupiter-recent');
  assert.equal(log.entries[0].data.baseline, true);
  assert.equal(log.entries[0].data.mint, recentMint);

  await callback(mint, poolId);
  assert.deepEqual(pools, [[mint, poolId]], 'le callback Raydium ne dépend pas de search');
  await clock.runDue();
  assert.deepEqual(calls, ['/tokens/v2/recent', '/tokens/v2/search']);
  const enrichment = log.entries.find(e => e.data.enrichmentSource === 'jupiter-search');
  assert.equal(enrichment.data.status, 'found');
  assert.equal(enrichment.data.poolId, poolId);
  assert.equal(enrichment.data.token.liquidityUsd, 42);
  assert.doesNotMatch(JSON.stringify(log.entries), /TEST_ONLY_FAKE_JUPITER_KEY/);
  observer.stop();
});
