import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const { PublicKey } = require('@solana/web3.js');
const sourcePath = path.join(root, 'src/core/jupiterTokens.ts');
const js = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText;
const MAX_BYTES = 1024 * 1024;

// In every test, even the native HTTPS module is replaced: no network is possible.
function load(fakeRequest = () => { throw new Error('UNEXPECTED NETWORK'); }) {
  const mod = new Module(sourcePath);
  mod.filename = sourcePath;
  mod.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  const originalRequire = mod.require.bind(mod);
  mod.require = id => id === 'node:https' ? { request: fakeRequest } : originalRequire(id);
  mod._compile(js, sourcePath);
  return mod.exports;
}
const { JupiterTokensClient, JupiterApiError } = load();
function mint(n) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(n, 28);
  return new PublicKey(bytes).toBase58();
}
const A = mint(1);
const B = mint(2);
const C = mint(3);
const PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const json = data => ({ status: 200, data: JSON.stringify(data) });
function fixture(handler = () => json([]), options = {}) {
  const calls = [];
  const client = new JupiterTokensClient({ ...options, transport: async req => {
    calls.push(req);
    return handler(req, calls.length);
  } });
  return { client, calls };
}
function isError(code) {
  return error => error instanceof JupiterApiError && error.code === code;
}

// A synthetic Node HTTPS socket/stream. It records options and cannot open a socket.
function fakeHttps(replies) {
  const calls = [];
  function request(options, callback) {
    calls.push(options);
    const req = new EventEmitter();
    req.end = () => {
      const spec = replies[calls.length - 1] ?? replies.at(-1);
      if (spec.never) return;
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = spec.status ?? 200;
        response.headers = spec.headers ?? {};
        callback(response);
        setImmediate(() => {
          for (const chunk of spec.chunks ?? [Buffer.from('[]')]) {
            if (response.destroyed) break;
            response.write(chunk);
          }
          if (!response.destroyed) response.end();
        });
      });
    };
    return req;
  }
  return { request, calls };
}

describe('observations Tokens V2', () => {
  test('mappe les données complètes sans attribuer de verdict de sécurité', async () => {
    const row = {
      id: A, name: 'Example', symbol: 'EX', decimals: 9, tokenProgram: PROGRAM,
      firstPool: { id: B, createdAt: '2025-02-28T10:20:30.123Z' },
      updatedAt: '2025-03-01T12:34:56+01:00', liquidity: 123.45, usdPrice: 0.1,
      holderCount: 45, organicScore: 71.5, isVerified: false,
      audit: { isSus: true, mintAuthorityDisabled: false, freezeAuthorityDisabled: true, topHoldersPercentage: 20.5 },
      mintAuthority: null, unknown: 'not propagated',
    };
    const f = fixture(() => json([row]));
    assert.deepEqual(await f.client.recent(), [{
      mint: A, name: 'Example', symbol: 'EX', decimals: 9, tokenProgram: PROGRAM,
      firstPool: { id: B, createdAt: '2025-02-28T10:20:30.123Z' },
      updatedAt: '2025-03-01T12:34:56+01:00', liquidityUsd: 123.45, usdPrice: 0.1,
      holderCount: 45, organicScore: 71.5, isVerified: false,
      audit: { isSus: true, mintAuthorityDisabled: false, freezeAuthorityDisabled: true, topHoldersPercentage: 20.5 },
    }]);
    const found = await f.client.searchByMints([A]);
    assert.equal(found.get(A).mint, A);
    assert.equal(found.size, 1);
    assert.equal(Object.hasOwn(found.get(A), 'safe'), false);
  });

  test('préserve présence, null, false et true du drapeau isSus, distincts de son absence', async () => {
    const values = [null, false, true];
    for (const value of values) {
      const f = fixture(() => json([{ id: A, audit: { isSus: value, mintAuthorityDisabled: null, freezeAuthorityDisabled: null } }]));
      const [token] = await f.client.recent();
      assert(Object.hasOwn(token.audit, 'isSus'));
      assert.strictEqual(token.audit.isSus, value);
      assert(!Object.hasOwn(token.audit, 'mintAuthorityDisabled'));
      assert(!Object.hasOwn(token.audit, 'freezeAuthorityDisabled'));
    }
    let f = fixture(() => json([{ id: A, audit: {} }]));
    assert.deepEqual((await f.client.recent())[0].audit, {});
    f = fixture(() => json([{ id: A, audit: null }, { id: B }]));
    for (const t of await f.client.recent()) assert(!Object.hasOwn(t, 'audit'));
    for (const bad of [0, 'false', [], {}]) {
      f = fixture(() => json([{ id: A, audit: { isSus: bad } }]));
      await assert.rejects(f.client.recent(), isError('invalid_response'));
    }
  });

  test('ignore les champs optionnels nuls ou invalides et accepte les zéros légitimes', async () => {
    const f = fixture(() => json([
      { id: A, name: null, symbol: '', decimals: '9', tokenProgram: 'SPL', firstPool: { id: 'pool' },
        updatedAt: '2025-02-31T00:00:00Z', liquidity: -1, usdPrice: '0', holderCount: 1.5,
        organicScore: 100.1, isVerified: 'false', audit: { mintAuthorityDisabled: 1, freezeAuthorityDisabled: 'yes', topHoldersPercentage: 101 } },
      { id: B, name: 'Zero', decimals: 0, liquidity: 0, usdPrice: 0, holderCount: 0,
        organicScore: 0, isVerified: false, firstPool: { id: C, createdAt: null },
        audit: { isSus: false, mintAuthorityDisabled: false, freezeAuthorityDisabled: false, topHoldersPercentage: 0 } },
    ]));
    assert.deepEqual(await f.client.recent(), [
      { mint: A, audit: {} },
      { mint: B, name: 'Zero', decimals: 0, firstPool: { id: C }, liquidityUsd: 0, usdPrice: 0,
        holderCount: 0, organicScore: 0, isVerified: false,
        audit: { isSus: false, mintAuthorityDisabled: false, freezeAuthorityDisabled: false, topHoldersPercentage: 0 } },
    ]);
  });

  test('rejette ou ignore prudemment les nombres excessifs, dates et adresses mal formées', async () => {
    const body = `[{
      "id":"${A}", "decimals":256, "holderCount":9007199254740992,
      "liquidity":1e9999, "usdPrice":-0.01, "organicScore":-1, "tokenProgram":"1",
      "firstPool":{"id":"${B}","createdAt":"2024-02-30T01:02:03Z"},
      "updatedAt":"not-a-date", "audit":{"topHoldersPercentage":-1}
    }]`;
    const f = fixture(() => ({ status: 200, data: body }));
    assert.deepEqual(await f.client.recent(), [{ mint: A, firstPool: { id: B }, audit: {} }]);
  });

  test('tableaux vides, entrées invalides et réponse de forme incorrecte', async () => {
    let f = fixture(() => json([]));
    assert.deepEqual(await f.client.recent(), []);
    assert.deepEqual([...await f.client.searchByMints([A])], []);
    f = fixture(() => json([null, false, 'bad', {}, { id: 'SOL' }, { id: A }]));
    assert.deepEqual(await f.client.recent(), [{ mint: A }]);
    for (const data of ['{}', 'null', '"secret"', '[', '', new Uint8Array([0xff]), { data: [] }]) {
      f = fixture(() => ({ status: 200, data }));
      await assert.rejects(f.client.recent(), isError('invalid_response'));
    }
  });

  test('déduplique les observations identiques mais rejette des doublons contradictoires', async () => {
    let f = fixture(() => json([{ id: A }, { id: A }]));
    assert.deepEqual(await f.client.recent(), [{ mint: A }]);
    assert.equal((await f.client.searchByMints([A])).size, 1);
    f = fixture(() => json([{ id: A, audit: { isSus: false } }, { id: A, audit: { isSus: true } }]));
    await assert.rejects(f.client.recent(), isError('invalid_response'));
    await assert.rejects(f.client.searchByMints([A]), isError('invalid_response'));
  });
});

describe('recherche par mint canonique et par lots', () => {
  test('sans I/O pour liste vide ou entrée invalide, même en fin de liste ou clairsemée', async () => {
    const f = fixture();
    assert.deepEqual([...await f.client.searchByMints([])], []);
    const sparse = [A, , B];
    for (const bad of [['SOL'], [A, 'SOL'], [A, ` ${B}`], [A, `${B}\n`], [A, '1'],
      [A, '0'.repeat(44)], [A, null], sparse, null, 'SOL']) {
      await assert.rejects(f.client.searchByMints(bad), isError('invalid_response'));
    }
    assert.equal(f.calls.length, 0);
  });

  test('lots séquentiels de 100, déduplication et filtrage strict y compris inter-lots', async () => {
    const all = Array.from({ length: 205 }, (_, i) => mint(i + 100));
    const calls = [];
    const f = fixture(req => {
      const q = new URL(req.url).searchParams.get('query').split(',');
      calls.push(q);
      const rows = q.filter(m => m !== all[204]).map(id => ({ id }));
      // The missing last mint is returned in the wrong batch, as well as an unrelated mint.
      if (calls.length === 1) rows.push({ id: all[204] }, { id: A }, { id: all[0] });
      return json(rows);
    });
    const result = await f.client.searchByMints([...all, all[0], all[5], all[204]]);
    assert.deepEqual(calls.map(batch => batch.length), [100, 100, 5]);
    assert.deepEqual(calls.flat(), all);
    assert.equal(result.size, 204);
    assert(!result.has(A));
    assert(!result.has(all[204]));
    for (const id of all.slice(0, 204)) assert.equal(result.get(id).mint, id);
  });

  test('arrête les lots après erreur et ne retourne jamais un résultat partiel', async () => {
    const all = Array.from({ length: 101 }, (_, i) => mint(i + 500));
    const f = fixture((req, n) => n === 1 ? json([{ id: all[0] }]) : { status: 500, data: 'do not expose' });
    await assert.rejects(f.client.searchByMints(all), isError('network'));
    assert.equal(f.calls.length, 2);
  });
});

describe('sécurité, erreurs et transport', () => {
  test('ne fournit que des destinations fixes, méthodes GET et paramètres bornés', async () => {
    const key = 'example-observation-key';
    const f = fixture(() => json([]), { apiKey: key, timeoutMs: 1234 });
    assert(!inspect(f.client, { showHidden: true }).includes(key));
    assert(!JSON.stringify(f.client).includes(key));
    await f.client.recent();
    await f.client.searchByMints([A, B]);
    assert.equal(f.calls[0].url, 'https://api.jup.ag/tokens/v2/recent');
    assert.equal(new URL(f.calls[1].url).origin, 'https://api.jup.ag');
    assert.equal(new URL(f.calls[1].url).pathname, '/tokens/v2/search');
    assert.equal(new URL(f.calls[1].url).searchParams.get('query'), `${A},${B}`);
    for (const call of f.calls) {
      assert.equal(call.method, 'GET');
      assert.equal(call.headers['x-api-key'], key);
      assert.equal(call.headers.accept, 'application/json');
      assert.equal(call.headers['accept-encoding'], 'identity');
      assert.equal(call.timeoutMs, 1234);
      assert.equal(call.maxResponseBytes, MAX_BYTES);
      assert(call.signal instanceof AbortSignal);
      assert(!call.url.includes(key));
    }
    const noKey = fixture(); await noKey.client.recent();
    assert(!Object.hasOwn(noKey.calls[0].headers, 'x-api-key'));
  });

  test('refuse les options et clés mal formées sans dévoiler leurs contenus', () => {
    for (const timeoutMs of [0, 99, 30_001, 1.1, Infinity, NaN, '500']) {
      assert.throws(() => new JupiterTokensClient({ timeoutMs }), isError('invalid_response'));
    }
    for (const apiKey of ['', ' ', 'secret\r\nInjected: yes', 'x'.repeat(4097), 12]) {
      assert.throws(() => new JupiterTokensClient({ apiKey }), error => isError('invalid_response')(error) && !error.message.includes('secret'));
    }
    assert.throws(() => new JupiterTokensClient({ transport: 'https://attacker.invalid' }), isError('invalid_response'));
    assert.doesNotThrow(() => new JupiterTokensClient({ timeoutMs: 100 }));
    assert.doesNotThrow(() => new JupiterTokensClient({ timeoutMs: 30_000 }));
  });

  test('401/403, 429 et autres statuts sans corps ni message HTTP brut', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'unauthorized'], [429, 'rate_limited'],
      [400, 'network'], [500, 'network'], [503, 'network'], [301, 'invalid_response'], [302, 'invalid_response']]) {
      const f = fixture(() => ({ status, data: 'secret-body-and-location' }), { apiKey: 'secret-key' });
      let error;
      try { await f.client.recent(); } catch (e) { error = e; }
      assert(isError(code)(error));
      assert(!inspect(error, { showHidden: true }).includes('secret'));
      assert(!String(error.stack).includes('api.jup.ag'));
      assert.equal(error.cause, undefined);
      assert.equal(f.calls.length, 1);
    }
  });

  test('429: x-ratelimit-reset en secondes Unix, en-tête absent ou invalide', async () => {
    const now = Date.now;
    Date.now = () => 1_899_999_995_000;
    try {
      let f = fixture(() => ({ status: 429, headers: { 'X-RateLimit-Reset': '1900000000' }, data: '' }));
      await assert.rejects(f.client.recent(), e => isError('rate_limited')(e) && e.retryAfterMs === 5000);
      f = fixture(() => ({ status: 429, headers: { 'x-ratelimit-reset': '1800000000' }, data: '' }));
      await assert.rejects(f.client.recent(), e => isError('rate_limited')(e) && e.retryAfterMs === 0);
      for (const reset of [undefined, '', '-1', '2.5', 'not-a-number', '9999999999999', ['1900000000']]) {
        f = fixture(() => ({ status: 429, headers: { 'x-ratelimit-reset': reset }, data: '' }));
        await assert.rejects(f.client.recent(), e => isError('rate_limited')(e) && e.retryAfterMs === undefined);
      }
    } finally { Date.now = now; }
  });

  test('exception du transport et expiration sont anonymisées, et le signal est annulé', async () => {
    let f = fixture(() => { throw new Error('secret-key https://evil.invalid'); }, { apiKey: 'secret-key' });
    let error;
    try { await f.client.recent(); } catch (e) { error = e; }
    assert(isError('network')(error));
    assert(!inspect(error, { showHidden: true }).includes('secret-key'));
    assert(!inspect(error, { showHidden: true }).includes('evil.invalid'));
    assert.equal(error.cause, undefined);
    f = fixture(() => new Promise(() => {}), { timeoutMs: 100 });
    await assert.rejects(f.client.recent(), isError('network'));
    assert.equal(f.calls[0].signal.aborted, true);
  });

  test('plafond strict de 1 Mio en octets, y compris UTF-8 et injection', async () => {
    let f = fixture(() => ({ status: 200, data: '[' + ' '.repeat(MAX_BYTES - 2) + ']' }));
    assert.deepEqual(await f.client.recent(), []);
    f = fixture(() => ({ status: 200, data: '[' + ' '.repeat(MAX_BYTES - 1) + ']' }));
    await assert.rejects(f.client.recent(), isError('invalid_response'));
    f = fixture(() => ({ status: 200, data: '["' + 'é'.repeat(MAX_BYTES / 2) + '"]' }));
    await assert.rejects(f.client.recent(), isError('invalid_response'));
    f = fixture(() => ({ status: 200, data: Buffer.alloc(MAX_BYTES + 1) }));
    await assert.rejects(f.client.recent(), isError('invalid_response'));
  });

  test('transport natif: HTTPS épinglé, aucun proxy ni redirection, clé en header seulement', async () => {
    const fake = fakeHttps([{ status: 302, headers: { location: 'https://attacker.invalid/secret' } }]);
    const { JupiterTokensClient: Client, JupiterApiError: ErrorClass } = load(fake.request);
    const c = new Client({ apiKey: 'secret-key' });
    await assert.rejects(c.recent(), e => e instanceof ErrorClass && e.code === 'invalid_response');
    assert.equal(fake.calls.length, 1);
    const opts = fake.calls[0];
    assert.equal(opts.protocol, 'https:');
    assert.equal(opts.hostname, 'api.jup.ag');
    assert.equal(opts.port, 443);
    assert.equal(opts.path, '/tokens/v2/recent');
    assert.equal(opts.method, 'GET');
    assert.equal(opts.agent, false);
    assert.equal(opts.rejectUnauthorized, true);
    assert.equal(opts.headers['x-api-key'], 'secret-key');
    assert(!opts.path.includes('secret-key'));
    assert(!inspect(opts).includes('attacker.invalid'));
  });

  test('transport natif: chemin search fixe et réponse 429 sans consommation de son corps', async () => {
    const fake = fakeHttps([
      { chunks: [Buffer.from(JSON.stringify([{ id: A }]))] },
      { status: 429, headers: { 'x-ratelimit-reset': '1' }, chunks: [Buffer.from('secret-body')] },
    ]);
    const { JupiterTokensClient: Client, JupiterApiError: ErrorClass } = load(fake.request);
    const client = new Client({ apiKey: 'secret-key' });
    assert.equal((await client.searchByMints([A])).get(A).mint, A);
    await assert.rejects(client.recent(), e => e instanceof ErrorClass && e.code === 'rate_limited'
      && e.retryAfterMs === 0 && !inspect(e).includes('secret'));
    assert.equal(fake.calls.length, 2);
    const search = new URL('https://api.jup.ag' + fake.calls[0].path);
    assert.equal(search.pathname, '/tokens/v2/search');
    assert.equal(search.searchParams.get('query'), A);
    assert(!search.toString().includes('secret'));
  });

  test('transport natif: flux borné, content-length et compression refusée', async () => {
    for (const reply of [
      { headers: { 'content-length': String(MAX_BYTES + 1) } },
      { headers: { 'content-encoding': 'gzip' } },
      { chunks: [Buffer.alloc(600_000, 32), Buffer.alloc(600_000, 32)] },
    ]) {
      const fake = fakeHttps([reply]);
      const { JupiterTokensClient: Client, JupiterApiError: ErrorClass } = load(fake.request);
      await assert.rejects(new Client().recent(), e => e instanceof ErrorClass && e.code === 'invalid_response');
      assert.equal(fake.calls.length, 1);
    }
    const fake = fakeHttps([{ chunks: [Buffer.from('[{"id":"'), Buffer.from(A + '"}]')] }]);
    const { JupiterTokensClient: Client } = load(fake.request);
    assert.deepEqual(await new Client().recent(), [{ mint: A }]);
  });
});
