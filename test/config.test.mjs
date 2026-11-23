import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, WSOL_MINT, loadConfig } from '../dist/config.js';

const real = { DRY_RUN: 'false', PRIVATE_KEY: 'FAKE_KEY', JUPITER_API_KEY: 'FAKE_API_KEY' };
const mustReject = (env) => assert.throws(() => loadConfig(env), ConfigError);

test('observation activée par défaut sans clé ni identifiant', () => {
  const config = loadConfig({});
  assert.equal(config.dryRun, true);
  assert.equal(config.useJito, false);
  assert.equal(config.buyAmountLamports, 100_000_000);
  assert.equal(config.slippageBps, 100);
  assert.equal(config.jupiterApiKey, undefined);
  assert.equal(config.privateKey, undefined);
  assert.equal(config.jupiterTokensEnabled, false);
  assert.equal(config.jupiterTokensApiKey, undefined);
  assert.equal(config.jupiterTokensPollIntervalMs, 5_000);
  assert.doesNotThrow(() => loadConfig({ PRIVATE_KEY: '', JUPITER_API_KEY: '' }));
});

test('mode réel toujours bloqué, y compris avec les deux clés, observation les ignore', () => {
  mustReject({ DRY_RUN: 'false' });
  mustReject({ DRY_RUN: 'false', PRIVATE_KEY: 'FAKE_KEY' });
  mustReject({ DRY_RUN: 'false', JUPITER_API_KEY: 'FAKE_API_KEY' });
  assert.throws(() => loadConfig(real), (error) =>
    error instanceof ConfigError && /désactivé/.test(error.message) && !error.message.includes('FAKE_KEY'));
  const observed = loadConfig({ ...real, DRY_RUN: 'true' });
  assert.equal(observed.dryRun, true);
  assert.equal(observed.privateKey, undefined);
  assert.equal(observed.jupiterApiKey, undefined);
});

test('Jupiter Tokens activé en observation avec ou sans sa propre clé', () => {
  const keyless = loadConfig({ JUPITER_TOKENS_ENABLED: 'true' });
  assert.equal(keyless.dryRun, true);
  assert.equal(keyless.jupiterTokensEnabled, true);
  assert.equal(keyless.jupiterTokensApiKey, undefined);
  assert.equal(keyless.jupiterTokensPollIntervalMs, 5_000);
  const config = loadConfig({
    JUPITER_TOKENS_ENABLED: 'true',
    JUPITER_TOKENS_API_KEY: '  FAKE_TOKENS_SECRET  ',
    JUPITER_API_KEY: 'FAKE_SWAP_SECRET',
    PRIVATE_KEY: 'FAKE_PRIVATE_SECRET',
    JUPITER_TOKENS_POLL_INTERVAL_MS: '12345',
  });
  assert.equal(config.jupiterTokensApiKey, 'FAKE_TOKENS_SECRET');
  assert.equal(config.jupiterTokensPollIntervalMs, 12_345);
  assert.equal(config.jupiterApiKey, undefined);
  assert.equal(config.privateKey, undefined);
  assert.throws(() => loadConfig({ JUPITER_TOKENS_ENABLED: 'true', JUPITER_TOKENS_API_KEY: '' }), ConfigError);
  assert.throws(() => loadConfig({ JUPITER_TOKENS_ENABLED: 'true', JUPITER_TOKENS_API_KEY: '   ' }), ConfigError);
});

test('ne lit ni clé privée ni ancienne clé Jupiter en observation, même avec Tokens', () => {
  const env = new Proxy({ JUPITER_TOKENS_ENABLED: 'true', JUPITER_TOKENS_API_KEY: 'FAKE_TOKENS_SECRET' }, {
    get(target, property) {
      if (property === 'PRIVATE_KEY' || property === 'JUPITER_API_KEY') throw new Error('Clé ignorée lue');
      return Reflect.get(target, property);
    },
  });
  assert.equal(loadConfig(env).jupiterTokensApiKey, 'FAKE_TOKENS_SECRET');
});

test('clé Tokens ignorée lorsque la fonctionnalité est désactivée', () => {
  // Le secret n'est pas utilisé : même présent ou vide, il n'est pas validé ni retourné.
  for (const input of ['FAKE_TOKENS_SECRET', '', '   ']) {
    for (const enabled of [undefined, 'false']) {
      const config = loadConfig({ JUPITER_TOKENS_ENABLED: enabled, JUPITER_TOKENS_API_KEY: input });
      assert.equal(config.jupiterTokensEnabled, false);
      assert.equal(config.jupiterTokensApiKey, undefined);
    }
  }
  const env = new Proxy({}, { get(target, property) {
    if (property === 'JUPITER_TOKENS_API_KEY') throw new Error('Clé Tokens désactivée lue');
    return Reflect.get(target, property);
  } });
  assert.equal(loadConfig(env).jupiterTokensApiKey, undefined);
  // L'intervalle reste une configuration stricte, y compris en mode désactivé.
  mustReject({ JUPITER_TOKENS_ENABLED: 'false', JUPITER_TOKENS_POLL_INTERVAL_MS: '4999' });
});

test('intervalle Jupiter Tokens entier strict dans les bornes inclusives', () => {
  for (const [input, expected] of [['5000', 5_000], ['5001', 5_001], ['59999', 59_999], ['60000', 60_000]]) {
    assert.equal(loadConfig({ JUPITER_TOKENS_POLL_INTERVAL_MS: input }).jupiterTokensPollIntervalMs, expected);
  }
  for (const bad of ['', ' ', '0', '4999', '60001', '-5000', '+5000', '5000.0', '5e3', '5000ms', 'NaN', 'Infinity', '99999999999999999999999']) {
    mustReject({ JUPITER_TOKENS_POLL_INTERVAL_MS: bad });
  }
});

test('erreurs de configuration Tokens sans fuite de secrets', () => {
  const secret = 'FAKE_TOKENS_SECRET';
  for (const env of [
    { JUPITER_TOKENS_ENABLED: secret, JUPITER_TOKENS_API_KEY: secret },
    { JUPITER_TOKENS_ENABLED: 'true', JUPITER_TOKENS_API_KEY: secret, JUPITER_TOKENS_POLL_INTERVAL_MS: secret },
    { JUPITER_TOKENS_ENABLED: 'true', JUPITER_TOKENS_API_KEY: secret, RPC_URL: `invalid-${secret}` },
    { DRY_RUN: 'false', JUPITER_TOKENS_ENABLED: 'true', JUPITER_TOKENS_API_KEY: secret },
  ]) {
    assert.throws(() => loadConfig(env), (error) =>
      error instanceof ConfigError && !String(error.stack).includes(secret) && !error.message.includes(secret));
  }
});

test('chargement et erreurs de configuration ne journalisent pas la clé Tokens', (t) => {
  const secret = 'FAKE_TOKENS_SECRET';
  const logged = [];
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, name, (...args) => logged.push(args.map(String).join(' ')));
  }
  assert.equal(loadConfig({ JUPITER_TOKENS_ENABLED: 'true', JUPITER_TOKENS_API_KEY: secret }).jupiterTokensApiKey, secret);
  mustReject({ JUPITER_TOKENS_ENABLED: 'true', JUPITER_TOKENS_API_KEY: secret, JUPITER_TOKENS_POLL_INTERVAL_MS: secret });
  assert.ok(logged.every(line => !line.includes(secret)));
});

test('booléens stricts, y compris valeurs vides', () => {
  for (const name of ['DRY_RUN', 'USE_JITO', 'JUPITER_TOKENS_ENABLED']) {
    for (const bad of ['', '1', 'yes', 'TRUE', 'falsex']) mustReject({ [name]: bad });
    assert.doesNotThrow(() => loadConfig({ [name]: 'true' }));
    if (name === 'DRY_RUN') mustReject({ ...real, [name]: 'false' });
    else assert.doesNotThrow(() => loadConfig({ [name]: 'false' }));
  }
});

test('SLIPPAGE décimal converti exactement en points de base', () => {
  for (const [input, bps] of [['0', 0], ['0.01', 1], ['1.25', 125], ['12.34', 1234], ['100', 10000]]) {
    assert.equal(loadConfig({ SLIPPAGE: input }).slippageBps, bps);
  }
  for (const bad of ['', '-1', '100.01', '1.234', '1%', '1e2', 'NaN', 'Infinity', '1.2x']) {
    mustReject({ SLIPPAGE: bad });
  }
});

test('BUY_AMOUNT est positif, précis au lamport et borné', () => {
  assert.equal(loadConfig({ BUY_AMOUNT: '0.000000001' }).buyAmountLamports, 1);
  assert.equal(loadConfig({ BUY_AMOUNT: '0.123456789' }).buyAmountLamports, 123_456_789);
  assert.equal(loadConfig({ BUY_AMOUNT: '9007199.254740991' }).buyAmountLamports, Number.MAX_SAFE_INTEGER);
  for (const bad of ['', '0', '-1', '0.0000000001', '9007199.254740990', '9007199.254740992', '1e-3', '0.1SOL', 'NaN', 'Infinity']) {
    mustReject({ BUY_AMOUNT: bad });
  }
});

test('pourboire Jito en lamports et montant positif lorsque Jito est activé', () => {
  assert.equal(loadConfig({ USE_JITO: 'true', JITO_TIP: '0.000001' }).jitoTipLamports, 1000);
  assert.equal(loadConfig({ USE_JITO: 'true', JITO_TIP: '0.005' }).jitoTipLamports, 5_000_000);
  assert.equal(loadConfig({ USE_JITO: 'false', JITO_TIP: '0' }).jitoTipLamports, 0);
  for (const input of ['0', '0.000000999', '0.005000001']) mustReject({ USE_JITO: 'true', JITO_TIP: input });
  for (const bad of ['', '-1', '1e-3', '0.0000000001', 'abc', '9007199.254740992']) {
    mustReject({ JITO_TIP: bad });
  }
});

test('anciennes options de sécurité inopérantes rejetées même à false ou vides', () => {
  for (const name of ['CHECK_IF_BURNED', 'CHECK_IF_RENOUNCED', 'MIN_LIQUIDITY']) {
    for (const input of ['', 'false', 'true', '1']) mustReject({ [name]: input });
  }
  assert.doesNotThrow(() => loadConfig({ QUOTE_MINT: WSOL_MINT }));
  mustReject({ QUOTE_MINT: '' });
  mustReject({ QUOTE_MINT: 'AUTRE_MINT' });
  mustReject({ JITO_BLOCK_ENGINE_URL: 'https://example.invalid' });
});

test('RPC et WebSocket vérifiés sans divulguer les URLs dans les erreurs', () => {
  assert.doesNotThrow(() => loadConfig({ RPC_URL: 'https://example.invalid', WS_URL: 'wss://example.invalid' }));
  for (const env of [
    { RPC_URL: 'file://example.invalid' },
    { RPC_URL: 'not-a-url-FAKE_SECRET' },
    { WS_URL: 'https://example.invalid' },
    { WS_URL: '' },
  ]) {
    assert.throws(() => loadConfig(env), (error) => error instanceof ConfigError && !error.message.includes('FAKE_SECRET'));
  }
});
