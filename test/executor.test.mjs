import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import dns from 'node:dns';
import vm from 'node:vm';
import { Keypair, SystemInstruction, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { SwapExecutor as RealSwapExecutor } from '../dist/core/executor.js';

// Garde-fou supplémentaire pour tout ce fichier de test : même en cas de
// régression, aucune connexion TCP, résolution DNS ou utilisation du fetch
// global ne doit avoir lieu. Les transports métier ci-dessous sont aussi
// explicitement simulés et leurs appels comptés.
const blockedNetwork = [];
const originalConnect = net.Socket.prototype.connect;
const originalLookup = dns.lookup;
const originalFetch = globalThis.fetch;
before(() => {
  net.Socket.prototype.connect = function () { blockedNetwork.push('socket'); throw new Error('Réseau interdit en test'); };
  dns.lookup = function () { blockedNetwork.push('DNS'); throw new Error('DNS interdit en test'); };
  globalThis.fetch = function () { blockedNetwork.push('fetch global'); throw new Error('Réseau interdit en test'); };
});
after(() => {
  net.Socket.prototype.connect = originalConnect;
  dns.lookup = originalLookup;
  globalThis.fetch = originalFetch;
  assert.deepEqual(blockedNetwork, [], 'aucune tentative réseau ne doit avoir lieu');
});

const WSOL = 'So11111111111111111111111111111111111111112';
function fixture({ malicious = false } = {}) {
  const wallet = Keypair.generate();
  const token = Keypair.generate().publicKey.toBase58();
  const recipient = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  // Le quote est cohérent, mais la transaction détourne 0,5 SOL au profit
  // d'un tiers au lieu d'acheter le token demandé avec 0,1 SOL.
  const instructions = malicious ? [SystemProgram.transfer({
    fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 500_000_000,
  })] : [];
  const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const swap = { swapTransaction: Buffer.from(tx.serialize()).toString('base64'), lastValidBlockHeight: 12345 };
  const quote = { inputMint: WSOL, outputMint: token, inAmount: '100000000', outAmount: '200',
    otherAmountThreshold: '190', swapMode: 'ExactIn', slippageBps: 500, routePlan: [{}] };
  return { wallet, token, recipient, blockhash, tx, quote, swap };
}
function mockFetch(f, transform = x => x) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    const data = String(url).includes('/quote?') ? f.quote : f.swap;
    return { ok: true, status: 200, json: async () => transform(data) };
  };
  return { fetcher, calls };
}

test('module dist réel : verrou indépendant avant réseau, signature et envoi, même face à une transaction malveillante', async t => {
  const f = fixture({ malicious: true });
  const transfer = SystemInstruction.decodeTransfer(TransactionMessage.decompile(f.tx.message).instructions[0]);
  assert(transfer.toPubkey.equals(f.recipient));
  assert.equal(transfer.lamports, 500_000_000n);
  assert.equal(f.tx.message.header.numRequiredSignatures, 1);
  assert(f.tx.message.staticAccountKeys[0].equals(f.wallet.publicKey));

  const mock = mockFetch(f);
  const calls = { sign: 0, send: 0, confirm: 0, overriddenPrepare: 0 };
  t.mock.method(VersionedTransaction.prototype, 'sign', () => {
    calls.sign++;
    throw new Error('Signature interdite');
  });
  const connection = {
    async sendRawTransaction() { calls.send++; throw new Error('Envoi interdit'); },
    async confirmTransaction() { calls.confirm++; throw new Error('Confirmation interdite'); },
  };
  // Les propriétés supplémentaires ne sont pas des options réelles et ne
  // doivent en aucun cas servir de mécanisme de déverrouillage.
  const executor = new RealSwapExecutor(connection, f.wallet, {
    apiKey: 'mock', fetcher: mock.fetcher, enabled: true, liveExecution: true, unsafeBypass: true,
  });
  assert.equal(await executor.prepareBuyTransaction(f.token, 0.1, 500), null);
  assert.equal(await executor.prepareBuyTransaction(f.token, 0.1, 500, true), null);
  assert.equal(await executor.buyToken(f.token, 0.1, 500), null);

  // La méthode d'achat doit également se protéger indépendamment de la
  // préparation, même si celle-ci est remplacée par une transaction forgée.
  executor.prepareBuyTransaction = async () => {
    calls.overriddenPrepare++;
    return { transaction: f.tx, lastValidBlockHeight: 12345 };
  };
  assert.equal(await executor.buyToken(f.token, 0.1, 500), null);
  assert.deepEqual(mock.calls, []);
  assert.deepEqual(calls, { sign: 0, send: 0, confirm: 0, overriddenPrepare: 0 });
  assert(f.tx.signatures.every(signature => signature.every(byte => byte === 0)));
});

// HARNAIS DE LOGIQUE UNIQUEMENT HORS RÉSEAU : ceci charge une copie en mémoire
// du module dist et remplace le verrou par une fonction fictive qui ne bloque
// PAS. Il n'exerce donc JAMAIS le verrou réel et ne démontre aucune sécurité
// des transactions. Les seuls transports fournis sont des objets simulés ; le
// fetch par défaut lève toujours une erreur, et aucun accès réseau n'est permis.
// Ce harnais sert seulement à préserver les tests historiques de logique.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiledSource = readFileSync(new URL('../dist/core/executor.js', import.meta.url), 'utf8');
const javascript = ts.transpileModule(compiledSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
let mockLockCalls = 0;
const silentLogger = { info() {}, warn() {}, error() {} };
const imports = {
  '@solana/web3.js': require('@solana/web3.js'),
  bs58: require('bs58'),
  'cross-fetch': () => { throw new Error('Fetch par défaut interdit dans le harnais'); },
  pino: () => silentLogger,
  '../security.js': { assertLiveExecutionAvailable() { mockLockCalls++; } },
};
const harnessModule = { exports: {} };
vm.runInNewContext(javascript, {
  module: harnessModule, exports: harnessModule.exports, Buffer, AbortSignal, URLSearchParams,
  require(id) {
    if (!Object.hasOwn(imports, id)) throw new Error(`Import interdit dans le harnais : ${id}`);
    return imports[id];
  },
});
const { SwapExecutor: OfflineLogicExecutor } = harnessModule.exports;

test('harnais hors réseau, verrou simulé : préparation et paramètres Jupiter', async () => {
  const f = fixture(), mock = mockFetch(f);
  const executor = new OfflineLogicExecutor({}, f.wallet, { apiKey: 'mock', fetcher: mock.fetcher });
  const beforeLocks = mockLockCalls;
  const prepared = await executor.prepareBuyTransaction(f.token, 0.1, 500, true);
  assert.equal(mockLockCalls, beforeLocks + 1);
  assert.ok(prepared);
  assert.equal(prepared.lastValidBlockHeight, 12345);
  assert.equal(prepared.transaction.message.recentBlockhash, f.blockhash);
  assert.match(mock.calls[0].url, /^https:\/\/api\.jup\.ag\/swap\/v1\/quote\?/);
  assert.match(mock.calls[0].url, /forJitoBundle=true/);
  assert.equal(mock.calls[0].init.headers['x-api-key'], 'mock');
  assert.ok(prepared.transaction.signatures[0].some(b => b !== 0));
});

test('harnais hors réseau, verrou simulé : un quote cohérent ne valide PAS la transaction', async () => {
  const f = fixture({ malicious: true }), mock = mockFetch(f);
  const executor = new OfflineLogicExecutor({}, f.wallet, { apiKey: 'mock', fetcher: mock.fetcher });
  const prepared = await executor.prepareBuyTransaction(f.token, 0.1, 500);
  // Démonstration du risque critique lorsque le verrou fictif ne bloque pas :
  // ce test local ne constitue pas une validation ni une autorisation réelle.
  assert.ok(prepared);
  const transfer = SystemInstruction.decodeTransfer(TransactionMessage.decompile(prepared.transaction.message).instructions[0]);
  assert(transfer.toPubkey.equals(f.recipient));
  assert.equal(transfer.lamports, 500_000_000n);
  assert.ok(prepared.transaction.signatures[0].some(b => b !== 0));
  assert.equal(mock.calls.length, 2);
});

test('harnais hors réseau, verrou simulé : quote incohérent ou swap incomplet refusés', async () => {
  const f = fixture();
  for (const modified of [
    { ...f, quote: { ...f.quote, outputMint: Keypair.generate().publicKey.toBase58() } },
    { ...f, quote: { ...f.quote, inAmount: '1' } },
    { ...f, quote: { ...f.quote, routePlan: [] } },
    { ...f, swap: { ...f.swap, lastValidBlockHeight: undefined } },
    { ...f, swap: { ...f.swap, simulationError: { error: 'failure' } } },
  ]) {
    const mock = mockFetch(modified);
    const executor = new OfflineLogicExecutor({}, f.wallet, { apiKey: 'mock', fetcher: mock.fetcher });
    assert.equal(await executor.prepareBuyTransaction(f.token, 0.1, 500), null);
  }
});

test('harnais hors réseau, verrou simulé : payeur, montants et erreurs HTTP', async () => {
  const f = fixture();
  const other = fixture();
  const mock = mockFetch({ ...f, swap: other.swap });
  const executor = new OfflineLogicExecutor({}, f.wallet, { apiKey: 'mock', fetcher: mock.fetcher });
  assert.equal(await executor.prepareBuyTransaction(f.token, 0.1, 500), null);
  assert.equal(await executor.prepareBuyTransaction(f.token, NaN, 500), null);
  assert.equal(await executor.prepareBuyTransaction(f.token, 0.1, 10001), null);
  const failed = new OfflineLogicExecutor({}, f.wallet, { apiKey: 'mock', fetcher: async () => ({ ok: false, status: 429 }) });
  assert.equal(await failed.prepareBuyTransaction(f.token, 0.1, 500), null);
});

test('harnais hors réseau, verrou simulé : succès uniquement après confirmation simulée', async () => {
  const f = fixture(), mock = mockFetch(f);
  let sent = 0, confirmed;
  const connection = {
    async sendRawTransaction(bytes, opts) {
      sent++; assert.equal(opts.skipPreflight, false); assert.equal(opts.maxRetries, 0);
      return bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]);
    },
    async confirmTransaction(strategy, commitment) {
      confirmed = { strategy, commitment }; return { value: { err: null } };
    },
  };
  const executor = new OfflineLogicExecutor(connection, f.wallet, { apiKey: 'mock', fetcher: mock.fetcher });
  const signature = await executor.buyToken(f.token, 0.1, 500);
  assert.ok(signature); assert.equal(sent, 1); assert.equal(confirmed.strategy.signature, signature);
  assert.equal(confirmed.strategy.blockhash, f.blockhash); assert.equal(confirmed.strategy.lastValidBlockHeight, 12345);
  assert.equal(confirmed.commitment, 'confirmed');
});

test('harnais hors réseau, verrou simulé : confirmation en erreur ou ambiguë sans nouvel achat', async () => {
  for (const ambiguous of [false, true]) {
    const f = fixture(), mock = mockFetch(f); let sent = 0;
    const connection = {
      async sendRawTransaction(bytes) { sent++; return bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]); },
      async confirmTransaction() { if (ambiguous) throw new Error('timeout'); return { value: { err: { InstructionError: [0, 'failed'] } } }; },
    };
    const executor = new OfflineLogicExecutor(connection, f.wallet, { apiKey: 'mock', fetcher: mock.fetcher });
    assert.equal(await executor.buyToken(f.token, 0.1, 500), null); assert.equal(sent, 1);
  }
});
