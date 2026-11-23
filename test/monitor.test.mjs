import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// Charge uniquement monitor.ts en mémoire, avec un RPC et un logger simulés.
// Aucun point d'entrée du bot, portefeuille ou transport réseau n'est créé.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const errors = [];
const logger = { info() {}, warn() {}, error(...args) { errors.push(args); } };
const source = readFileSync(new URL('../src/core/monitor.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const moduleObject = { exports: {} };
const imports = {
  '@solana/web3.js': { PublicKey },
  bs58: { default: bs58, __esModule: true },
  pino: () => logger,
};
vm.runInNewContext(javascript, {
  module: moduleObject,
  exports: moduleObject.exports,
  require(id) {
    if (!(id in imports)) throw new Error(`Unexpected import: ${id}`);
    return imports[id];
  },
});
const { PoolMonitor } = moduleObject.exports;
const RAYDIUM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const pk = byte => new PublicKey(Buffer.alloc(32, byte));
const POOL = pk(40);
const TOKEN = pk(41);
const OTHER = pk(42);

function initialize2({ pool = POOL, mintA = TOKEN, mintB = WSOL, tag = 1, length = 26, program = RAYDIUM } = {}) {
  const accounts = Array.from({ length: 21 }, (_, i) => pk(i + 1));
  accounts[4] = pool;
  accounts[8] = mintA;
  accounts[9] = mintB;
  const data = Buffer.alloc(length);
  if (length) data[0] = tag;
  return { programId: program, accounts, data: bs58.encode(data) };
}

function transaction(instructions, innerInstructions = [], err = null) {
  return {
    // Deliberately unrelated to the instruction accounts.
    transaction: { message: { instructions, accountKeys: Array.from({ length: 10 }, (_, i) => ({ pubkey: pk(i + 80) })) } },
    meta: { err, innerInstructions: [{ index: 0, instructions: innerInstructions }], postTokenBalances: [{ mint: pk(99).toBase58() }] },
  };
}

function fakeConnection(getParsedTransaction) {
  let handler;
  let subscriptions = 0;
  return {
    onLogs(program, callback, commitment) {
      assert.equal(program.toBase58(), RAYDIUM.toBase58());
      assert.equal(commitment, 'confirmed');
      subscriptions++;
      handler = callback;
      return subscriptions;
    },
    getParsedTransaction,
    emit(signature, err = null, logs = []) { return handler({ signature, err, logs }); },
    get subscriptions() { return subscriptions; },
  };
}

async function runWith(tx, signature = 'signature') {
  const got = [];
  const connection = fakeConnection(async () => tx);
  const monitor = new PoolMonitor(connection);
  await monitor.start((mint, pool) => got.push([mint, pool]));
  await connection.emit(signature);
  return got;
}

test('instruction principale : comptes locaux, pas soldes ni accountKeys, avec WSOL des deux côtés possibles', async () => {
  const pool2 = pk(43);
  const instructions = [initialize2(), initialize2({ pool: pool2, mintA: WSOL, mintB: OTHER })];
  const got = await runWith(transaction(instructions));
  assert.deepEqual(got, [[TOKEN.toBase58(), POOL.toBase58()], [OTHER.toBase58(), pool2.toBase58()]]);
});

test('instruction interne décodée même sans mot-clé dans les logs et avec instruction principale parsée', async () => {
  const parsed = { programId: pk(201), program: 'autre', parsed: {} };
  const got = await runWith(transaction([parsed], [initialize2()]));
  assert.deepEqual(got, [[TOKEN.toBase58(), POOL.toBase58()]]);
});

test('ignore mauvais programme, mauvais tag, base58 invalide, données ou comptes incomplets', async () => {
  const invalidData = { ...initialize2(), data: 'not base58! 0' };
  const insufficientAccounts = { ...initialize2(), accounts: initialize2().accounts.slice(0, 10) };
  const parsedRaydium = { programId: RAYDIUM, program: 'raydium', parsed: {} };
  const instructions = [
    initialize2({ program: pk(202) }), initialize2({ tag: 3 }), initialize2({ length: 25 }),
    invalidData, insufficientAccounts, parsedRaydium,
  ];
  assert.deepEqual(await runWith(transaction(instructions)), []);
});

test('refuse les paires sans WSOL et les paires WSOL/WSOL', async () => {
  const instructions = [initialize2({ mintA: TOKEN, mintB: OTHER }), initialize2({ mintA: WSOL, mintB: WSOL })];
  assert.deepEqual(await runWith(transaction(instructions)), []);
});

test('ignore les transactions en erreur et les notifications en erreur', async () => {
  let requests = 0;
  const got = [];
  const connection = fakeConnection(async () => { requests++; return transaction([initialize2()], [], { InstructionError: [0, 'error'] }); });
  const monitor = new PoolMonitor(connection);
  await monitor.start((mint, pool) => got.push([mint, pool]));
  await connection.emit('error-in-notification', { failed: true });
  await connection.emit('error-in-meta');
  assert.equal(requests, 1);
  assert.deepEqual(got, []);
});

test('dédoublonne les notifications concurrentes, les signatures et les pools, et ne souscrit qu’une fois', async () => {
  let requests = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const connection = fakeConnection(async () => { requests++; await gate; return transaction([initialize2(), initialize2()]); });
  const got = [];
  const monitor = new PoolMonitor(connection);
  await monitor.start((mint, pool) => got.push([mint, pool]));
  await monitor.start(() => { throw new Error('second callback must not be installed'); });
  const first = connection.emit('s1');
  await connection.emit('s1');
  release();
  await first;
  await connection.emit('s1');
  await connection.emit('s2');
  assert.equal(connection.subscriptions, 1);
  assert.equal(requests, 2);
  assert.deepEqual(got, [[TOKEN.toBase58(), POOL.toBase58()]]);
});

test('attend le callback, intercepte ses erreurs et continue vers le pool suivant sans réessayer', async () => {
  const pool2 = pk(44);
  const tx = transaction([initialize2(), initialize2({ pool: pool2, mintA: OTHER })]);
  const connection = fakeConnection(async () => tx);
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const monitor = new PoolMonitor(connection);
  await monitor.start(async (mint, pool) => {
    calls.push(pool);
    if (pool === POOL.toBase58()) { await gate; throw new Error('synthetic callback failure'); }
  });
  const emitted = connection.emit('s1');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [POOL.toBase58()]);
  release();
  await emitted;
  assert.deepEqual(calls, [POOL.toBase58(), pool2.toBase58()]);
  await connection.emit('s2');
  assert.equal(calls.length, 2);
  assert.ok(errors.some(args => args[1] === 'Erreur du callback de pool'));
});

test('une transaction momentanément indisponible peut être retraitée sur une nouvelle notification', async () => {
  let requests = 0;
  const connection = fakeConnection(async () => (++requests === 1 ? null : transaction([initialize2()])));
  const got = [];
  const monitor = new PoolMonitor(connection);
  await monitor.start((mint, pool) => got.push([mint, pool]));
  await connection.emit('s1');
  await connection.emit('s1');
  assert.equal(requests, 2);
  assert.deepEqual(got, [[TOKEN.toBase58(), POOL.toBase58()]]);
});

test('une erreur RPC est interceptée et la signature peut être retraitée', async () => {
  let requests = 0;
  const connection = fakeConnection(async () => { if (++requests === 1) throw new Error('synthetic RPC error'); return transaction([initialize2()]); });
  const got = [];
  const monitor = new PoolMonitor(connection);
  await monitor.start((mint, pool) => got.push([mint, pool]));
  await connection.emit('s1');
  await connection.emit('s1');
  assert.equal(requests, 2);
  assert.deepEqual(got, [[TOKEN.toBase58(), POOL.toBase58()]]);
  assert.ok(errors.some(args => args[1] === 'Erreur lors du traitement de la transaction Raydium'));
});

test('préfiltre les logs ordinaires mais inspecte les logs tronqués ou absents', async () => {
  let requests = 0;
  const connection = fakeConnection(async () => { requests++; return transaction([initialize2()]); });
  const got = [];
  const monitor = new PoolMonitor(connection);
  await monitor.start((mint, pool) => got.push([mint, pool]));
  await connection.emit('swap-ordinaire', null, ['Program log: swap']);
  assert.equal(requests, 0);
  await connection.emit('logs-tronques', null, ['Log truncated']);
  await connection.emit('logs-absents', null, []);
  assert.equal(requests, 2);
  assert.deepEqual(got, [[TOKEN.toBase58(), POOL.toBase58()]]);
});

test('refuse explicitement la variante Initialize2 à 19 comptes non couverte par le format demandé', async () => {
  const instruction = initialize2();
  instruction.accounts = instruction.accounts.slice(0, 19);
  instruction.accounts[7] = TOKEN;
  instruction.accounts[8] = WSOL;
  instruction.accounts[9] = pk(75);
  assert.deepEqual(await runWith(transaction([instruction])), []);
});
