import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Compile uniquement le service en mémoire. L'import du type client est effacé :
// aucun client HTTP, portefeuille, RPC ou point d'entrée du bot n'est chargé.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../src/core/jupiterObservation.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { JupiterObservation } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

class Clock {
  time = 0;
  sequence = 0;
  timers = new Map();
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = id => this.timers.delete(id);
  async advance(ms = 0) {
    const target = this.time + ms;
    for (let count = 0; count < 10_000; count++) {
      await flush();
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) {
        this.time = target;
        await flush();
        return;
      }
      this.time = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    throw new Error('Fake-clock runaway');
  }
}

function fixture({ recent = async () => [], search = async () => new Map(), options = {}, handlers = {} } = {}) {
  const clock = new Clock();
  const events = { recent: [], enrichment: [], errors: [] };
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const client = {
    async recent() {
      calls.push({ type: 'recent', at: clock.time });
      active++;
      maxActive = Math.max(maxActive, active);
      try { return await recent(); } finally { active--; }
    },
    async searchByMints(mints) {
      calls.push({ type: 'search', at: clock.time, mints: [...mints] });
      active++;
      maxActive = Math.max(maxActive, active);
      try { return await search(mints); } finally { active--; }
    },
  };
  const observer = new JupiterObservation(client, {
    onRecent: handlers.onRecent ?? (event => events.recent.push(event)),
    onEnrichment: handlers.onEnrichment ?? (event => events.enrichment.push(event)),
    onError: handlers.onError ?? (event => events.errors.push(event)),
  }, { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, ...options });
  return { clock, events, calls, observer, get maxActive() { return maxActive; } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const token = (mint, poolId, createdAt) => ({ mint, ...(poolId ? { firstPool: { id: poolId, createdAt } } : {}) });

test('premier instantané baseline, doublons et indexation tardive sans filtre temporel', async () => {
  const snapshots = [
    [token('A', 'pool-jupiter', '2020-01-01T00:00:00Z'), token('B')],
    [token('A', 'pool-jupiter'), token('B', 'pool-apparu'), token('C', 'ancien', '2000-01-01T00:00:00Z')],
    [token('C', 'ancien'), token('A', 'pool-jupiter')],
  ];
  const f = fixture({ recent: async () => snapshots.shift() ?? [] });
  f.observer.start();
  f.observer.start();
  await f.clock.advance();
  assert.deepEqual(f.events.recent.map(e => [e.source, e.mint, e.poolId, e.baseline]), [
    ['jupiter-recent', 'A', 'pool-jupiter', true], ['jupiter-recent', 'B', undefined, true],
  ]);
  await f.clock.advance(5_000);
  assert.deepEqual(f.events.recent.map(e => [e.mint, e.baseline]), [['A', true], ['B', true], ['C', false]]);
  assert.equal(f.events.recent[2].poolId, 'ancien');
  await f.clock.advance(5_000);
  assert.equal(f.events.recent.length, 3);
  assert.equal(f.calls.filter(c => c.type === 'recent').length, 3);
  assert.equal(f.maxActive, 1);
  f.observer.stop();
});

test('une baseline vide est réussie ; une erreur ne consomme pas la première baseline', async () => {
  let count = 0;
  const f = fixture({ recent: async () => {
    count++;
    if (count === 1) throw { code: 'network', message: 'secret à ne pas exposer' };
    return count === 2 ? [] : [token('late')];
  } });
  f.observer.start();
  await f.clock.advance();
  assert.equal(f.events.errors[0].code, 'network');
  assert.doesNotMatch(JSON.stringify(f.events.errors), /secret/);
  await f.clock.advance(10_000);
  assert.deepEqual(f.events.recent.map(e => [e.mint, e.baseline]), [['late', false]]);
  f.observer.stop();

  let fails = true;
  const g = fixture({ recent: async () => {
    if (fails) { fails = false; throw { code: 'network' }; }
    return [token('first')];
  } });
  g.observer.start();
  await g.clock.advance(5_000);
  assert.equal(g.events.recent[0].baseline, true);
  g.observer.stop();
});

test('deux pools Raydium pour un mint, source distincte, déduplication et mint absent', async () => {
  const f = fixture({ recent: async () => [token('A', 'jupiter-first')], search: async mints => {
    assert.deepEqual(mints, ['A', 'missing']);
    return new Map([['A', token('A', 'jupiter-first')], ['missing', token('wrong')]]);
  } });
  f.observer.start();
  f.observer.observeRaydium('A', 'raydium-1');
  f.observer.observeRaydium('A', 'raydium-1');
  f.observer.observeRaydium('A', 'raydium-2');
  f.observer.observeRaydium('missing', 'raydium-3');
  assert.equal(f.events.enrichment.length, 0, 'observeRaydium est non bloquant');
  await f.clock.advance();
  assert.deepEqual(f.calls.map(c => c.type), ['recent', 'search']);
  assert.equal(f.events.recent[0].poolId, 'jupiter-first');
  assert.deepEqual(f.events.enrichment.map(e => [e.source, e.enrichmentSource, e.mint, e.poolId, e.status]), [
    ['raydium', 'jupiter-search', 'A', 'raydium-1', 'found'],
    ['raydium', 'jupiter-search', 'A', 'raydium-2', 'found'],
    ['raydium', 'jupiter-search', 'missing', 'raydium-3', 'unknown'],
  ]);
  assert.equal(f.events.enrichment[2].reason, 'not_found');
  for (const event of [...f.events.recent, ...f.events.enrichment]) {
    assert.equal('isSafe' in event, false);
    assert.equal('safe' in event, false);
  }
  f.observer.observeRaydium('A', 'raydium-1');
  await f.clock.advance();
  assert.equal(f.calls.length, 2, 'une paire trouvée ne redéclenche pas la recherche');
  f.observer.stop();
});

test('recherche groupée par 100 mints au maximum, y compris plusieurs pools du même mint', async () => {
  const f = fixture({ search: async mints => new Map(mints.map(mint => [mint, token(mint)])) });
  f.observer.start();
  for (let i = 0; i < 101; i++) f.observer.observeRaydium(`M${i}`, `P${i}`);
  f.observer.observeRaydium('M0', 'P-autre');
  await f.clock.advance();
  const searches = f.calls.filter(c => c.type === 'search');
  assert.deepEqual(searches.map(c => c.mints.length), [100, 1]);
  assert.equal(new Set(searches.flatMap(c => c.mints)).size, 101);
  assert.equal(f.events.enrichment.length, 102);
  assert.equal(f.events.enrichment.filter(e => e.mint === 'M0').length, 2);
  assert.equal(f.maxActive, 1);
  f.observer.stop();
});

test('file bornée, double notification ignorée et débordement agrégé explicite', async () => {
  const f = fixture({ options: { maxQueueSize: 2 }, search: async mints => new Map(mints.map(mint => [mint, token(mint)])) });
  f.observer.start();
  f.observer.observeRaydium('A', '1');
  f.observer.observeRaydium('A', '1');
  f.observer.observeRaydium('B', '2');
  f.observer.observeRaydium('C', '3');
  f.observer.observeRaydium('D', '4');
  assert.equal(f.events.errors.length, 0);
  await f.clock.advance();
  assert.deepEqual(f.events.errors, [{ source: 'raydium', code: 'queue_full', mint: 'C', poolId: '3', droppedCount: 2 }]);
  assert.deepEqual(f.events.enrichment.map(e => e.mint), ['A', 'B']);
  assert.deepEqual(f.calls[1].mints, ['A', 'B']);
  f.observer.stop();
});

test('résultat inconnu après panne ou absence, puis nouvelle observation autorisée', async () => {
  let searchCount = 0;
  const f = fixture({ search: async mints => {
    searchCount++;
    if (searchCount === 1) throw { code: 'network', message: 'credential=SECRET' };
    if (searchCount === 2) return new Map();
    return new Map(mints.map(mint => [mint, token(mint)]));
  } });
  f.observer.start();
  f.observer.observeRaydium('A', 'P');
  await f.clock.advance();
  f.observer.observeRaydium('A', 'P');
  await f.clock.advance();
  f.observer.observeRaydium('A', 'P');
  await f.clock.advance();
  assert.deepEqual(f.events.enrichment.map(e => [e.status, e.reason]), [
    ['unknown', 'network'], ['unknown', 'not_found'], ['found', undefined],
  ]);
  assert.deepEqual(f.events.errors.map(e => [e.source, e.mint, e.code]), [['jupiter-search', 'A', 'network']]);
  assert.doesNotMatch(JSON.stringify(f.events), /SECRET|credential/);
  f.observer.stop();
});

test('une panne recent ne bloque pas le traitement Raydium et respecte les 5 s après fin', async () => {
  const first = deferred();
  let count = 0;
  const f = fixture({ recent: async () => {
    if (count++ === 0) return await first.promise;
    return [];
  }, search: async mints => new Map(mints.map(mint => [mint, token(mint)])) });
  f.observer.start();
  await f.clock.advance();
  f.observer.observeRaydium('A', 'P');
  await f.clock.advance(2_000);
  assert.deepEqual(f.calls.map(c => c.type), ['recent']);
  first.reject({ code: 'network' });
  await f.clock.advance();
  assert.deepEqual(f.calls.map(c => c.type), ['recent', 'search']);
  assert.equal(f.events.enrichment[0].status, 'found');
  await f.clock.advance(4_999);
  assert.equal(f.calls.length, 2);
  await f.clock.advance(1);
  assert.equal(f.calls[2].at, 7_000);
  assert.equal(f.maxActive, 1);
  f.observer.stop();
});

test('quota global 24 requêtes par 60 s sur recent et search, sans chevauchement', async () => {
  const f = fixture({ options: { maxBatchSize: 1 }, search: async mints => new Map(mints.map(mint => [mint, token(mint)])) });
  f.observer.start();
  for (let i = 0; i < 30; i++) f.observer.observeRaydium(`M${i}`, `P${i}`);
  await f.clock.advance();
  assert.equal(f.calls.length, 24);
  assert.equal(f.calls[0].type, 'recent');
  assert.equal(f.calls.filter(c => c.type === 'search').length, 23);
  f.observer.stop();
  f.observer.start();
  f.observer.observeRaydium('post-restart', 'P');
  await f.clock.advance(59_999);
  assert.equal(f.calls.length, 24);
  await f.clock.advance(1);
  assert.ok(f.calls.length > 24);
  for (const call of f.calls) {
    assert.ok(f.calls.filter(c => c.at <= call.at && c.at > call.at - 60_000).length <= 24);
  }
  assert.equal(f.maxActive, 1);
  f.observer.stop();
});

test('429 impose un backoff global, conserve retryAfter et ne se réinitialise pas à stop/start', async () => {
  let attempt = 0;
  const f = fixture({ recent: async () => {
    if (attempt++ === 0) throw { code: 'rate_limited', retryAfterMs: 8_000, message: 'SECRET' };
    return [];
  }, search: async mints => new Map(mints.map(mint => [mint, token(mint)])) });
  f.observer.start();
  f.observer.observeRaydium('A', 'P');
  await f.clock.advance();
  assert.equal(f.events.errors[0].code, 'rate_limited');
  f.observer.stop();
  f.observer.start();
  f.observer.observeRaydium('A', 'P');
  await f.clock.advance(7_999);
  assert.equal(f.calls.length, 1);
  await f.clock.advance(1);
  assert.deepEqual(f.calls.map(c => [c.type, c.at]), [['recent', 0], ['recent', 8_000], ['search', 8_000]]);
  assert.doesNotMatch(JSON.stringify(f.events.errors), /SECRET/);
  f.observer.stop();

  let n = 0;
  const longReset = fixture({ recent: async () => {
    if (n++ === 0) throw { code: 'rate_limited', retryAfterMs: 1_000_000 };
    return [];
  } });
  longReset.observer.start();
  await longReset.clock.advance(999_999);
  assert.equal(longReset.calls.length, 1);
  await longReset.clock.advance(1);
  assert.deepEqual(longReset.calls.map(c => c.at), [0, 1_000_000]);
  longReset.observer.stop();
});

test('un très long délai 429 découpe les timers sans reprendre avant le reset', async () => {
  let attempts = 0;
  const reset = 2_147_483_649;
  const f = fixture({ recent: async () => {
    if (attempts++ === 0) throw { code: 'rate_limited', retryAfterMs: reset };
    return [];
  } });
  f.observer.start();
  await f.clock.advance();
  assert.equal([...f.clock.timers.values()][0].at, 2_147_483_647);
  await f.clock.advance(reset - 1);
  assert.equal(f.calls.length, 1);
  await f.clock.advance(1);
  assert.deepEqual(f.calls.map(c => c.at), [0, reset]);
  f.observer.stop();
});

test('429 reçu après arrêt et redémarrage impose son backoff à la nouvelle génération', async () => {
  const oldRequest = deferred();
  let attempt = 0;
  const f = fixture({ recent: async () => ++attempt === 1 ? await oldRequest.promise : [] });
  f.observer.start();
  await f.clock.advance();
  f.observer.stop();
  f.observer.start();
  f.observer.observeRaydium('A', 'P');
  oldRequest.reject({ code: 'rate_limited', retryAfterMs: 60_000 });
  await f.clock.advance(59_999);
  assert.deepEqual(f.calls.map(c => c.at), [0]);
  await f.clock.advance(1);
  assert.deepEqual(f.calls.map(c => [c.type, c.at]), [['recent', 0], ['recent', 60_000], ['search', 60_000]]);
  f.observer.stop();
});

test('401 tardif suspend le client redémarré et marque sa file inconnue', async () => {
  const oldRequest = deferred();
  const f = fixture({ recent: async () => await oldRequest.promise });
  f.observer.start();
  await f.clock.advance();
  f.observer.stop();
  f.observer.start();
  f.observer.observeRaydium('A', 'P');
  oldRequest.reject({ code: 'unauthorized' });
  await f.clock.advance(100_000);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.events.errors.map(e => e.code), ['unauthorized']);
  assert.deepEqual(f.events.enrichment.map(e => [e.mint, e.status, e.reason]), [['A', 'unknown', 'unauthorized']]);
  f.observer.stop();
});

test('des 429 avec reset nul utilisent un recul exponentiel même si l’horloge est décalée', async () => {
  const f = fixture({ options: { pollIntervalMs: 1 }, recent: async () => {
    throw { code: 'rate_limited', retryAfterMs: 0 };
  } });
  f.observer.start();
  await f.clock.advance(6_999);
  assert.deepEqual(f.calls.map(c => c.at), [0, 1_000, 3_000]);
  await f.clock.advance(1);
  assert.deepEqual(f.calls.map(c => c.at), [0, 1_000, 3_000, 7_000]);
  f.observer.stop();
});

test('auth suspend toute observation, signale unknown en file et exige stop/start explicite', async () => {
  let n = 0;
  const f = fixture({ recent: async () => {
    if (n++ === 0) throw { code: 'unauthorized', message: 'SECRET' };
    return [];
  } });
  f.observer.start();
  f.observer.observeRaydium('A', 'P1');
  f.observer.observeRaydium('B', 'P2');
  await f.clock.advance();
  assert.equal(f.events.errors[0].code, 'unauthorized');
  assert.deepEqual(f.events.enrichment.map(e => [e.mint, e.status, e.reason]), [
    ['A', 'unknown', 'unauthorized'], ['B', 'unknown', 'unauthorized'],
  ]);
  f.observer.observeRaydium('C', 'P3');
  f.observer.start();
  await f.clock.advance(100_000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.clock.timers.size, 0);
  f.observer.stop();
  f.observer.start();
  await f.clock.advance();
  assert.equal(f.calls.length, 2);
  f.observer.stop();
});

test('auth sur search vide le lot et la file, sans recherche supplémentaire', async () => {
  const f = fixture({ options: { maxBatchSize: 1 }, search: async () => {
    throw { code: 'unauthorized', message: 'SECRET_TOKEN' };
  } });
  f.observer.start();
  f.observer.observeRaydium('A', 'P1');
  f.observer.observeRaydium('B', 'P2');
  await f.clock.advance();
  assert.deepEqual(f.calls.map(c => c.type), ['recent', 'search']);
  assert.deepEqual(f.events.enrichment.map(e => [e.mint, e.status, e.reason]), [
    ['A', 'unknown', 'unauthorized'], ['B', 'unknown', 'unauthorized'],
  ]);
  assert.deepEqual(f.events.errors.map(e => [e.source, e.code]), [['jupiter-search', 'unauthorized']]);
  await f.clock.advance(100_000);
  assert.equal(f.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(f.events), /SECRET_TOKEN/);
  f.observer.stop();
});

test('réponse invalide : pas de baseline artificielle et enrichissement inconnu', async () => {
  let polls = 0;
  const f = fixture({ recent: async () => ++polls === 1 ? {} : [token('A')], search: async () => ({}) });
  f.observer.start();
  f.observer.observeRaydium('A', 'P');
  await f.clock.advance();
  assert.deepEqual(f.events.errors.map(e => [e.source, e.code]), [
    ['jupiter-recent', 'invalid_response'], ['jupiter-search', 'invalid_response'],
  ]);
  assert.deepEqual(f.events.enrichment.map(e => [e.mint, e.status, e.reason]), [['A', 'unknown', 'invalid_response']]);
  await f.clock.advance(5_000);
  assert.equal(f.events.recent[0].baseline, true);
  f.observer.stop();
});

test('429 sans retryAfter utilise un délai minimal et signale le lot comme inconnu', async () => {
  let searches = 0;
  const f = fixture({ options: { maxBatchSize: 1 }, search: async mints => {
    if (++searches === 1) throw { code: 'rate_limited' };
    return new Map(mints.map(mint => [mint, token(mint)]));
  } });
  f.observer.start();
  f.observer.observeRaydium('A', 'P1');
  f.observer.observeRaydium('B', 'P2');
  await f.clock.advance();
  assert.deepEqual(f.events.enrichment.map(e => [e.mint, e.status, e.reason]), [['A', 'unknown', 'rate_limited']]);
  await f.clock.advance(999);
  assert.equal(f.calls.length, 2);
  await f.clock.advance(1);
  assert.equal(f.calls[2].at, 1_000);
  assert.equal(f.events.enrichment[1].status, 'found');
  f.observer.stop();
});

test('arrêt annule timers et callbacks en vol ; redémarrage attend la fin physique', async () => {
  const request = deferred();
  let count = 0;
  const f = fixture({ recent: async () => ++count === 1 ? await request.promise : [token('new')],
    search: async mints => new Map(mints.map(mint => [mint, token(mint)])) });
  f.observer.start();
  await f.clock.advance();
  f.observer.observeRaydium('old', 'P');
  f.observer.stop();
  assert.equal(f.clock.timers.size, 0);
  f.observer.start();
  f.observer.observeRaydium('new', 'P');
  await f.clock.advance();
  assert.equal(f.calls.length, 1);
  request.resolve([token('old')]);
  await f.clock.advance();
  assert.deepEqual(f.events.recent.map(e => [e.mint, e.baseline]), [['new', true]]);
  assert.deepEqual(f.events.enrichment.map(e => e.mint), ['new']);
  assert.equal(f.maxActive, 1);
  f.observer.stop();
  assert.equal(f.clock.timers.size, 0);
  await f.clock.advance(100_000);
  assert.equal(f.calls.length, 3);
});

test('stop annule aussi une alerte de débordement pas encore émise', async () => {
  const request = deferred();
  const f = fixture({ options: { maxQueueSize: 1 }, recent: async () => await request.promise });
  f.observer.start();
  await f.clock.advance();
  f.observer.observeRaydium('A', 'P1');
  f.observer.observeRaydium('B', 'P2');
  assert.ok(f.clock.timers.size > 0);
  f.observer.stop();
  assert.equal(f.clock.timers.size, 0);
  request.resolve([token('old')]);
  await f.clock.advance(100_000);
  assert.deepEqual(f.events, { recent: [], enrichment: [], errors: [] });
  assert.equal(f.clock.timers.size, 0);
});

test('erreurs de callback isolées, aucune fuite des messages et aucune notification après stop', async () => {
  const rejection = deferred();
  const f = fixture({ recent: async () => [token('A'), token('B')], handlers: {
    onRecent: event => {
      if (event.mint === 'A') throw new Error('SECRET_SYNC');
      return rejection.promise;
    },
  } });
  f.observer.start();
  await f.clock.advance();
  assert.deepEqual(f.events.errors.map(e => [e.mint, e.code]), [['A', 'handler_error']]);
  f.observer.stop();
  rejection.reject(new Error('SECRET_ASYNC'));
  await flush();
  assert.equal(f.events.errors.length, 1);
  assert.doesNotMatch(JSON.stringify(f.events.errors), /SECRET/);
});

test('caches de déduplication bornés, distincts, avec répétition possible après éviction', async () => {
  const snapshots = [[token('A'), token('B')], [token('A')]];
  const f = fixture({ options: { maxRecentSeen: 1, maxRaydiumSeen: 1 }, recent: async () => snapshots.shift() ?? [],
    search: async mints => new Map(mints.map(mint => [mint, token(mint)])) });
  f.observer.start();
  f.observer.observeRaydium('A', 'P1');
  await f.clock.advance();
  f.observer.observeRaydium('B', 'P2');
  await f.clock.advance();
  f.observer.observeRaydium('A', 'P1');
  await f.clock.advance();
  await f.clock.advance(5_000);
  assert.deepEqual(f.events.recent.map(e => [e.mint, e.baseline]), [['A', true], ['B', true], ['A', false]]);
  assert.deepEqual(f.events.enrichment.map(e => e.mint), ['A', 'B', 'A']);
  f.observer.stop();
});

test('le module ne comporte aucune voie transactionnelle ni dépendance HTTP ou sécurité', () => {
  assert.doesNotMatch(javascript, /\b(?:require|import)\s*\(?\s*['"](?:@solana|axios|node:https|\.\/executor|\.\/excavator|\.\/monitor)/);
  assert.doesNotMatch(javascript, /\b(?:sendTransaction|signTransaction|executeSwap|buy|analyzeToken|rugcheck)\b/i);
  assert.match(source, /import type \{ JupiterToken \}/);
});
