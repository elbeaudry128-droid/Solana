import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const bs58 = require('bs58').default;
const {
  AddressLookupTableAccount, Keypair, PublicKey, SystemInstruction, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} = require('@solana/web3.js');
const { deserializeTransactions } = require('jito-ts/dist/sdk/block-engine/utils.js');
const { ed25519 } = require('@noble/curves/ed25519');
const sourcePath = path.join(root, 'src/core/jito.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const js = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText;
const JUPITER = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const BLOCKHASH = PublicKey.default.toBase58();

// Load the actual central gate from TypeScript, rather than a stale build or a stub.
function loadRealGate() {
  const securityPath = path.join(root, 'src/security.ts');
  const securityJs = ts.transpileModule(fs.readFileSync(securityPath, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const security = new Module(securityPath);
  security.filename = securityPath;
  security.paths = Module._nodeModulePaths(path.dirname(securityPath));
  security._compile(securityJs, securityPath);
  return security.exports;
}

// The historical offline tests stub the gate as well as the existing I/O fakes.
// The real-gate tests keep the same I/O fakes but load the real gate unchanged.
function fixture(overrides = {}) {
  const wallet = Keypair.generate();
  const tip = Keypair.generate().publicKey;
  const calls = { tip: 0, send: 0, simulate: 0, confirm: 0, subscribe: 0, lookup: 0, bundles: [], logs: [] };
  const fakeSearcher = {
    async getTipAccounts() { calls.tip++; return overrides.tipResult ?? { ok: true, value: [tip.toBase58()] }; },
    async sendBundle(bundle) { calls.send++; calls.bundles.push(bundle); return overrides.sendResult ?? { ok: true, value: 'bundle-test-123' }; },
    onBundleResult() { calls.subscribe++; throw new Error('Unexpected subscription'); },
  };
  const fakeConnection = {
    async simulateTransaction(tx, config) { calls.simulate++; calls.simulated = tx; calls.simulationConfig = config; return overrides.simulation ?? { value: { err: null } }; },
    async confirmTransaction(sig, commitment) {
      calls.confirm++; calls.confirmArgs = { sig, commitment };
      if (overrides.confirm) return overrides.confirm(sig, commitment);
      return { value: { err: null } };
    },
    async getAddressLookupTable(key) { calls.lookup++; return { value: overrides.tables?.find(t => t.key.equals(key)) ?? null }; },
  };
  let initialized = 0;
  const mocked = {
    '../security.js': overrides.realGate ? loadRealGate() : { assertLiveExecutionAvailable() {} },
    'jito-ts': { searcher: { searcherClient: () => { initialized++; return fakeSearcher; } } },
    'pino': () => Object.fromEntries(['info', 'warn', 'error'].map(level => [level, msg => calls.logs.push({ level, msg })])),
  };
  const mod = new Module(sourcePath);
  mod.filename = sourcePath;
  mod.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  const originalRequire = mod.require.bind(mod);
  mod.require = id => Object.hasOwn(mocked, id) ? mocked[id] : originalRequire(id);
  mod._compile(js, sourcePath);
  const executor = new mod.exports.JitoExecutor(fakeConnection, wallet, overrides.endpoint ?? 'frankfurt.mainnet.block-engine.jito.wtf');
  return { wallet, tip, calls, executor, initialized };
}
function makeTx(wallet, opts = {}) {
  const instruction = opts.instruction ?? new TransactionInstruction({
    programId: opts.program ?? JUPITER,
    keys: opts.keys ?? [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }],
    data: Buffer.from(opts.data ?? [42, 7]),
  });
  const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: BLOCKHASH, instructions: [instruction] });
  const tx = new VersionedTransaction(opts.legacy ? msg.compileToLegacyMessage() : msg.compileToV0Message(opts.tables ?? []));
  if (!opts.unsigned && tx.message.header.numRequiredSignatures === 1) tx.sign([wallet]);
  return tx;
}

describe('Verrou réel : exécution interdite avant tout accès réseau ou signature', () => {
  test('bloque même une transaction synthétique avec ALT et les entrées invalides', async () => {
    const swapAccount = Keypair.generate().publicKey;
    const table = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0,
        authority: undefined, addresses: [swapAccount] },
    });
    const f = fixture({ realGate: true, tables: [table] });
    const tx = makeTx(f.wallet, { unsigned: true, tables: [table],
      keys: [{ pubkey: swapAccount, isSigner: false, isWritable: true }] });
    assert.equal(tx.message.addressTableLookups.length, 1);
    const originalSignatures = tx.signatures.map(signature => Buffer.from(signature));
    const originalSign = VersionedTransaction.prototype.sign;
    let signCalls = 0;
    VersionedTransaction.prototype.sign = function () { signCalls++; throw new Error('Signature interdite dans ce test'); };
    try {
      await assert.rejects(f.executor.sendBundle([tx], 1000), /Exécution réelle désactivée/);
      // A poisoned input also proves that the gate precedes transaction inspection.
      const poisoned = new Proxy([], { get() { throw new Error('Transactions inspectées'); } });
      await assert.rejects(f.executor.sendBundle(poisoned, NaN, -1), /Exécution réelle désactivée/);
    } finally {
      VersionedTransaction.prototype.sign = originalSign;
    }
    assert.equal(signCalls, 0);
    assert.deepEqual(tx.signatures.map(signature => Buffer.from(signature)), originalSignatures);
    assert.deepEqual({ tip: f.calls.tip, send: f.calls.send, simulate: f.calls.simulate,
      confirm: f.calls.confirm, subscribe: f.calls.subscribe, lookup: f.calls.lookup },
    { tip: 0, send: 0, simulate: 0, confirm: 0, subscribe: 0, lookup: 0 });
    assert.equal(f.calls.bundles.length, 0);
    assert.equal(f.calls.logs.length, 0);
  });

  test('bloque aussi avant le contrôle du client Jito non initialisé', async () => {
    const f = fixture({ realGate: true, endpoint: 'attacker.example:443' });
    assert.equal(f.initialized, 0);
    const logCount = f.calls.logs.length;
    await assert.rejects(f.executor.sendBundle([], 0), /Exécution réelle désactivée/);
    assert.equal(f.calls.logs.length, logCount);
    assert.equal(f.calls.tip, 0);
    assert.equal(f.calls.simulate, 0);
    assert.equal(f.calls.send, 0);
  });
});

describe('Verrou simulé : tests historiques isolés hors réseau', () => {
for (const legacy of [false, true]) test(`tip intégré et ID confirmé : ${legacy ? 'legacy' : 'v0'}`, async () => {
  const f = fixture();
  const input = makeTx(f.wallet, { legacy });
  const original = Buffer.from(input.serialize());
  assert.equal(await f.executor.sendBundle([input], 1_000_000), 'bundle-test-123');
  assert.equal(f.calls.send, 1);
  assert.equal(f.calls.tip, 1);
  assert.equal(f.calls.simulate, 1);
  assert.equal(f.calls.subscribe, 0);
  assert.deepEqual(Buffer.from(input.serialize()), original, 'la transaction initiale ne doit pas être modifiée');
  const txs = deserializeTransactions(f.calls.bundles[0].packets);
  assert.equal(txs.length, 1, 'aucune transaction de tip autonome');
  const tx = txs[0];
  const decompiled = TransactionMessage.decompile(tx.message);
  assert.equal(decompiled.instructions.length, 2);
  assert(decompiled.instructions[0].programId.equals(JUPITER));
  assert.deepEqual(decompiled.instructions[0].data, Buffer.from([42, 7]));
  const transfer = SystemInstruction.decodeTransfer(decompiled.instructions[1]);
  assert(transfer.fromPubkey.equals(f.wallet.publicKey));
  assert(transfer.toPubkey.equals(f.tip));
  assert.equal(transfer.lamports, 1_000_000n);
  assert(ed25519.verify(tx.signatures[0], tx.message.serialize(), f.wallet.publicKey.toBytes()));
  assert.equal(f.calls.confirmArgs.sig, bs58.encode(tx.signatures[0]));
  assert.equal(f.calls.confirmArgs.commitment, 'confirmed');
  assert.equal(f.calls.simulationConfig.sigVerify, true);
  assert(f.calls.logs.some(x => x.msg.includes('non confirmé')));
});

test('les montants invalides et les bundles multiples ou vides sont bloqués avant tout appel', async () => {
  const f = fixture(); const tx = makeTx(f.wallet);
  for (const amount of [0, -1, 999, 1000.5, NaN, Infinity, 5_000_001, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await f.executor.sendBundle([tx], amount), null);
  }
  for (const txs of [[], [tx, tx], [tx, tx, tx, tx, tx], [null]]) {
    assert.equal(await f.executor.sendBundle(txs, 1000), null);
  }
  assert.equal(f.calls.tip, 0); assert.equal(f.calls.simulate, 0); assert.equal(f.calls.send, 0);
  assert(f.calls.logs.some(x => x.msg.includes('tips autonomes')));
});

test('le tip utilise la liste courante et échoue fermement si elle est absente ou mal formée', async () => {
  for (const tipResult of [
    { ok: false, error: new Error('erreur non publique') },
    { ok: true, value: [] },
    { ok: true, value: ['clé-invalide'] },
    { ok: true, value: [17] },
    { ok: true, value: [SystemProgram.programId.toBase58()] },
  ]) {
    const f = fixture({ tipResult });
    assert.equal(await f.executor.sendBundle([makeTx(f.wallet)], 1000), null);
    assert.equal(f.calls.send, 0); assert.equal(f.calls.simulate, 0);
  }
  const f = fixture({ endpoint: 'attacker.example:443' });
  assert.equal(f.initialized, 0);
  assert.equal(await f.executor.sendBundle([makeTx(f.wallet)], 1000), null);
  assert.equal(f.calls.send, 0);
});

test('les transactions sans Jupiter ou avec plusieurs signataires sont refusées', async () => {
  const f = fixture();
  const withoutSwap = makeTx(f.wallet, { program: SystemProgram.programId });
  const extraSigner = Keypair.generate();
  const multi = makeTx(f.wallet, { keys: [
    { pubkey: f.wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: extraSigner.publicKey, isSigner: true, isWritable: false },
  ] });
  assert.equal(await f.executor.sendBundle([withoutSwap], 1000), null);
  assert.equal(await f.executor.sendBundle([multi], 1000), null);
  assert.equal(f.calls.send, 0);
});

test('une simulation rejetée ou une transaction trop grande ne sont jamais soumises', async () => {
  let f = fixture({ simulation: { value: { err: { InstructionError: [0, 'bad'] } } } });
  assert.equal(await f.executor.sendBundle([makeTx(f.wallet)], 1000), null);
  assert.equal(f.calls.simulate, 1); assert.equal(f.calls.send, 0);
  f = fixture();
  const tooLarge = makeTx(f.wallet, { data: Buffer.alloc(1050) });
  assert.equal(await f.executor.sendBundle([tooLarge], 1000), null);
  assert.equal(f.calls.send, 0);
});

test('le Result Jito est interprété correctement et une erreur ne vaut pas confirmation', async () => {
  const f = fixture({ sendResult: { ok: false, error: { code: 13, message: 'sensible' } } });
  assert.equal(await f.executor.sendBundle([makeTx(f.wallet)], 1000), null);
  assert.equal(f.calls.send, 1); assert.equal(f.calls.confirm, 0);
  assert(f.calls.logs.some(x => x.msg.includes('code 13')));
  assert(!f.calls.logs.some(x => x.msg.includes('sensible')));
  const g = fixture({ sendResult: { ok: true, value: '' } });
  assert.equal(await g.executor.sendBundle([makeTx(g.wallet)], 1000), null);
  assert.equal(g.calls.confirm, 0);
});

test('une soumission reste en attente jusqu’à la confirmation et un timeout reste inconnu', async () => {
  let reject;
  const waiting = new Promise((_, rej) => { reject = rej; });
  const f = fixture({ confirm: () => waiting });
  const promise = f.executor.sendBundle([makeTx(f.wallet)], 1000);
  await new Promise(resolve => setImmediate(resolve));
  let settled = false; promise.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.send, 1); assert.equal(f.calls.confirm, 1); assert.equal(settled, false);
  reject(new Error('timeout'));
  assert.equal(await promise, null);
  assert(f.calls.logs.some(x => x.msg.includes('statut inconnu')));
  assert.equal(f.calls.subscribe, 0);
  const g = fixture({ confirm: async () => ({ value: { err: { InstructionError: [0, 'fail'] } } }) });
  assert.equal(await g.executor.sendBundle([makeTx(g.wallet)], 1000), null);
});

test('la confirmation avec hauteur utilise le blockhash de la transaction, jamais un nouveau blockhash', async () => {
  const f = fixture();
  assert.equal(await f.executor.sendBundle([makeTx(f.wallet)], 1000, 12345), 'bundle-test-123');
  const sent = deserializeTransactions(f.calls.bundles[0].packets)[0];
  assert.deepEqual(f.calls.confirmArgs.sig, {
    signature: bs58.encode(sent.signatures[0]), blockhash: BLOCKHASH, lastValidBlockHeight: 12345,
  });
  const invalid = fixture();
  for (const height of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await invalid.executor.sendBundle([makeTx(invalid.wallet)], 1000, height), null);
  }
  assert.equal(invalid.calls.send, 0);
});

test('un compte déjà présent dans le swap ne peut pas être choisi pour le tip', async () => {
  const used = Keypair.generate().publicKey;
  const available = Keypair.generate().publicKey;
  const f = fixture({ tipResult: { ok: true, value: [used.toBase58(), available.toBase58()] } });
  const tx = makeTx(f.wallet, { keys: [{ pubkey: used, isSigner: false, isWritable: false }] });
  assert.equal(await f.executor.sendBundle([tx], 1000), 'bundle-test-123');
  const sent = deserializeTransactions(f.calls.bundles[0].packets)[0];
  const decoded = TransactionMessage.decompile(sent.message);
  assert.equal(decoded.instructions[0].keys[0].isWritable, false);
  assert(SystemInstruction.decodeTransfer(decoded.instructions[1]).toPubkey.equals(available));
});

test('les tables ALT sont résolues et le compte de tip reste statique', async () => {
  const t1 = Keypair.generate().publicKey;
  const t2 = Keypair.generate().publicKey;
  const swapAccount = Keypair.generate().publicKey;
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0,
      authority: undefined, addresses: [swapAccount, t1] },
  });
  const f = fixture({ tables: [table], tipResult: { ok: true, value: [t1.toBase58(), t2.toBase58()] } });
  const tx = makeTx(f.wallet, { tables: [table], keys: [{ pubkey: swapAccount, isSigner: false, isWritable: true }] });
  assert.equal(await f.executor.sendBundle([tx], 1000), 'bundle-test-123');
  const sent = deserializeTransactions(f.calls.bundles[0].packets)[0];
  assert(sent.message.staticAccountKeys.some(k => k.equals(t2)));
  const decoded = TransactionMessage.decompile(sent.message, { addressLookupTableAccounts: [table] });
  assert(SystemInstruction.decodeTransfer(decoded.instructions.at(-1)).toPubkey.equals(t2));
  const missing = fixture({ tipResult: { ok: true, value: [t2.toBase58()] } });
  const tx2 = makeTx(missing.wallet, { tables: [table], keys: [{ pubkey: swapAccount, isSigner: false, isWritable: true }] });
  assert.equal(await missing.executor.sendBundle([tx2], 1000), null);
  assert.equal(missing.calls.send, 0);
});
});
