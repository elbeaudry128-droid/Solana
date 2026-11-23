export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type BaseConfig = {
  rpcUrl: string;
  wsUrl?: string;
  buyAmountSol: number;
  buyAmountLamports: number;
  slippageBps: number;
  useJito: boolean;
  jitoBlockEngineUrl: string;
  jitoTipLamports: number;
  jupiterTokensEnabled: boolean;
  jupiterTokensApiKey?: string;
  jupiterTokensPollIntervalMs: number;
};

export type Config = BaseConfig & (
  | { dryRun: true; privateKey?: never; jupiterApiKey?: never }
  | { dryRun: false; privateKey: string; jupiterApiKey: string }
);

type Environment = Readonly<Record<string, string | undefined>>;
const MAX_SAFE_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER);

function value(env: Environment, name: string, fallback?: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) throw new ConfigError(`${name} ne doit pas être vide.`);
  return trimmed;
}

function booleanValue(env: Environment, name: string, fallback: boolean): boolean {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`${name} doit être exactement true ou false.`);
}

function tokensPollInterval(env: Environment): number {
  const raw = value(env, 'JUPITER_TOKENS_POLL_INTERVAL_MS', '5000')!;
  const interval = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(interval) || interval < 5_000 || interval > 60_000) {
    throw new ConfigError('JUPITER_TOKENS_POLL_INTERVAL_MS doit être un entier entre 5000 et 60000 inclus.');
  }
  return interval;
}

// Decimal arithmetic in integer units; no parseFloat, exponent or silent rounding.
function decimalUnits(raw: string, name: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match || raw.length > 32) {
    throw new ConfigError(`${name} doit être un nombre décimal non négatif sans exposant.`);
  }
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    throw new ConfigError(`${name} accepte au maximum ${decimals} décimales.`);
  }
  return BigInt(match[1]!) * 10n ** BigInt(decimals)
    + BigInt(fraction.padEnd(decimals, '0') || '0');
}

function solUnits(env: Environment, name: string, fallback: string, positive: boolean): number {
  const units = decimalUnits(value(env, name, fallback)!, name, 9);
  if (units > MAX_SAFE_LAMPORTS || (positive && units === 0n)) {
    throw new ConfigError(`${name} doit ${positive ? 'être supérieur à zéro et ' : ''}rester représentable en lamports entiers sûrs.`);
  }
  return Number(units);
}

function urlValue(env: Environment, name: string, protocols: string[], fallback?: string): string | undefined {
  const raw = value(env, name, fallback);
  if (raw === undefined) return undefined;
  try {
    const parsed = new URL(raw);
    if (!protocols.includes(parsed.protocol) || !parsed.hostname) throw new Error();
    return raw;
  } catch {
    // Never include the URL in an error: its path or query can contain credentials.
    throw new ConfigError(`${name} doit être une URL valide avec le protocole attendu.`);
  }
}

export function loadConfig(env: Environment = process.env): Config {
  for (const name of ['CHECK_IF_BURNED', 'CHECK_IF_RENOUNCED', 'MIN_LIQUIDITY']) {
    if (env[name] !== undefined) {
      throw new ConfigError(`${name} n'est pas appliqué : supprimez cette option de l'environnement.`);
    }
  }
  if (env.QUOTE_MINT !== undefined && env.QUOTE_MINT.trim() !== WSOL_MINT) {
    throw new ConfigError('QUOTE_MINT autre que WSOL n’est pas pris en charge : supprimez cette option.');
  }

  const dryRun = booleanValue(env, 'DRY_RUN', true);
  if (!dryRun) {
    throw new ConfigError('DRY_RUN=false est désactivé : la transaction Jupiter doit être validée indépendamment avant toute signature.');
  }
  const useJito = booleanValue(env, 'USE_JITO', false);
  const jupiterTokensEnabled = booleanValue(env, 'JUPITER_TOKENS_ENABLED', false);
  const jupiterTokensPollIntervalMs = tokensPollInterval(env);
  // Une clé non utilisée n'est ni lue ni validée lorsque l'observation Tokens est désactivée.
  const jupiterTokensApiKey = jupiterTokensEnabled ? value(env, 'JUPITER_TOKENS_API_KEY') : undefined;
  const buyAmountLamports = solUnits(env, 'BUY_AMOUNT', '0.1', true);
  const buyAmountSol = buyAmountLamports / 1_000_000_000;
  if (Math.round(buyAmountSol * 1_000_000_000) !== buyAmountLamports) {
    throw new ConfigError('BUY_AMOUNT ne peut pas être transmis avec une précision entière en lamports.');
  }
  const jitoTipLamports = solUnits(env, 'JITO_TIP', '0.001', false);
  if (useJito && (jitoTipLamports < 1_000 || jitoTipLamports > 5_000_000)) {
    throw new ConfigError('JITO_TIP doit être compris entre 1 000 et 5 000 000 lamports quand USE_JITO=true.');
  }
  const slippage = decimalUnits(value(env, 'SLIPPAGE', '1')!, 'SLIPPAGE', 2);
  if (slippage > 10_000n) throw new ConfigError('SLIPPAGE doit être compris entre 0 et 100 pour cent.');

  const jitoBlockEngineUrl = value(env, 'JITO_BLOCK_ENGINE_URL', 'frankfurt.mainnet.block-engine.jito.wtf')!;
  if (!/^(?:[a-z0-9-]+\.)?mainnet\.block-engine\.jito\.wtf(?::443)?$/i.test(jitoBlockEngineUrl)) {
    throw new ConfigError('JITO_BLOCK_ENGINE_URL doit désigner un hôte officiel Jito mainnet pris en charge.');
  }
  const base: BaseConfig = {
    rpcUrl: urlValue(env, 'RPC_URL', ['http:', 'https:'], 'https://api.mainnet-beta.solana.com')!,
    wsUrl: urlValue(env, 'WS_URL', ['ws:', 'wss:']),
    buyAmountSol,
    buyAmountLamports,
    slippageBps: Number(slippage),
    useJito,
    jitoBlockEngineUrl,
    jitoTipLamports,
    jupiterTokensEnabled,
    jupiterTokensApiKey,
    jupiterTokensPollIntervalMs,
  };

  if (dryRun) return { ...base, dryRun: true };
  const privateKey = value(env, 'PRIVATE_KEY');
  const jupiterApiKey = value(env, 'JUPITER_API_KEY');
  if (!privateKey) throw new ConfigError('PRIVATE_KEY est obligatoire lorsque DRY_RUN=false.');
  if (!jupiterApiKey) throw new ConfigError('JUPITER_API_KEY est obligatoire lorsque DRY_RUN=false.');
  return { ...base, dryRun: false, privateKey, jupiterApiKey };
}
