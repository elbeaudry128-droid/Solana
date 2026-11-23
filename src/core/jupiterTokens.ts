import { PublicKey } from '@solana/web3.js';
import { request as httpsRequest } from 'node:https';

/** Observation only: missing fields are unknown, not a security verdict. */
export type JupiterToken = {
  mint: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  tokenProgram?: string;
  firstPool?: { id: string; createdAt?: string };
  updatedAt?: string;
  liquidityUsd?: number;
  usdPrice?: number;
  holderCount?: number;
  organicScore?: number;
  isVerified?: boolean;
  audit?: {
    isSus?: boolean | null;
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
  };
};

export type JupiterApiErrorCode = 'unauthorized' | 'rate_limited' | 'network' | 'invalid_response';

/** Errors intentionally contain neither upstream messages, requests, URLs, nor causes. */
export class JupiterApiError extends Error {
  public readonly code: JupiterApiErrorCode;
  public readonly retryAfterMs?: number;

  constructor(code: JupiterApiErrorCode, retryAfterMs?: number) {
    const messages: Record<JupiterApiErrorCode, string> = {
      unauthorized: 'Jupiter authorization failed',
      rate_limited: 'Jupiter rate limit exceeded',
      network: 'Jupiter request failed',
      invalid_response: 'Invalid Jupiter input or response',
    };
    super(messages[code] ?? messages.network);
    this.name = 'JupiterApiError';
    this.code = Object.hasOwn(messages, code) ? code : 'network';
    if (this.code === 'rate_limited' && typeof retryAfterMs === 'number'
      && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

/**
 * A transport is trusted code and may see the API key. It must return raw bytes
 * (or a UTF-8 string), not parsed JSON, and should honor signal/byte limits.
 * A custom transport cannot change the destination chosen by this client, but
 * the client cannot prevent intentionally malicious injected code from leaking it.
 */
export type JupiterTokensRequest = {
  readonly url: string;
  readonly method: 'GET';
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal: AbortSignal;
};
export type JupiterTokensResponse = {
  status: number;
  headers?: Record<string, unknown>;
  data: string | Uint8Array;
};
export type JupiterTokensTransport = (request: JupiterTokensRequest) => Promise<JupiterTokensResponse>;
export type JupiterTokensClientOptions = {
  apiKey?: string;
  timeoutMs?: number;
  transport?: JupiterTokensTransport;
};

const ORIGIN = 'https://api.jup.ag';
const MAX_BYTES = 1024 * 1024;
const MAX_BATCH = 100;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44
    || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function optionalText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function dateTime(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  // Check the calendar separately: Date.parse normalizes invalid dates such as February 31.
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    && Number.isFinite(Date.parse(value));
}

function boundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function parseToken(value: unknown): JupiterToken | undefined {
  if (!isRecord(value) || !canonicalAddress(value.id)) return undefined;
  const token: JupiterToken = { mint: value.id };
  if (optionalText(value.name)) token.name = value.name;
  if (optionalText(value.symbol)) token.symbol = value.symbol;
  if (Number.isSafeInteger(value.decimals) && boundedNumber(value.decimals, 0, 255)) token.decimals = value.decimals;
  if (canonicalAddress(value.tokenProgram)) token.tokenProgram = value.tokenProgram;
  if (isRecord(value.firstPool) && canonicalAddress(value.firstPool.id)) {
    token.firstPool = { id: value.firstPool.id };
    if (dateTime(value.firstPool.createdAt)) token.firstPool.createdAt = value.firstPool.createdAt;
  }
  if (dateTime(value.updatedAt)) token.updatedAt = value.updatedAt;
  if (boundedNumber(value.liquidity, 0, Number.MAX_SAFE_INTEGER)) token.liquidityUsd = value.liquidity;
  if (boundedNumber(value.usdPrice, 0, Number.MAX_SAFE_INTEGER)) token.usdPrice = value.usdPrice;
  if (Number.isSafeInteger(value.holderCount) && boundedNumber(value.holderCount, 0, Number.MAX_SAFE_INTEGER)) token.holderCount = value.holderCount;
  if (boundedNumber(value.organicScore, 0, 100)) token.organicScore = value.organicScore;
  if (typeof value.isVerified === 'boolean') token.isVerified = value.isVerified;
  if (isRecord(value.audit)) {
    const audit: NonNullable<JupiterToken['audit']> = {};
    if (Object.hasOwn(value.audit, 'isSus')) {
      // Dropping an invalid flag would erase the fact that the flag was present.
      if (value.audit.isSus !== null && typeof value.audit.isSus !== 'boolean') throw new JupiterApiError('invalid_response');
      audit.isSus = value.audit.isSus;
    }
    if (typeof value.audit.mintAuthorityDisabled === 'boolean') audit.mintAuthorityDisabled = value.audit.mintAuthorityDisabled;
    if (typeof value.audit.freezeAuthorityDisabled === 'boolean') audit.freezeAuthorityDisabled = value.audit.freezeAuthorityDisabled;
    if (boundedNumber(value.audit.topHoldersPercentage, 0, 100)) audit.topHoldersPercentage = value.audit.topHoldersPercentage;
    token.audit = audit;
  }
  return token;
}

function retryDelay(headers: Record<string, unknown> | undefined): number | undefined {
  if (!headers || !isRecord(headers)) return undefined;
  const key = Object.keys(headers).find(name => name.toLowerCase() === 'x-ratelimit-reset');
  const raw = key === undefined ? undefined : headers[key];
  if (typeof raw !== 'string' || !/^\d{1,13}$/.test(raw)) return undefined;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) return undefined;
  const delay = Math.max(0, seconds * 1000 - Date.now());
  return Number.isSafeInteger(delay) ? delay : undefined;
}

/** Node HTTPS neither follows redirects nor uses an environment-configured HTTP proxy. */
const defaultTransport: JupiterTokensTransport = ({ url, headers, signal, maxResponseBytes }) => new Promise((resolve, reject) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.origin !== ORIGIN || parsed.username || parsed.password || parsed.hash
      || (parsed.pathname !== '/tokens/v2/search' && parsed.pathname !== '/tokens/v2/recent')) {
      throw new Error('invalid destination');
    }
  } catch {
    reject(new JupiterApiError('invalid_response'));
    return;
  }
  const req = httpsRequest({
    protocol: 'https:', hostname: 'api.jup.ag', port: 443,
    path: parsed.pathname + parsed.search, method: 'GET', headers,
    agent: false, rejectUnauthorized: true, signal,
  }, response => {
    const status = response.statusCode ?? 0;
    const responseHeaders = response.headers as Record<string, unknown>;
    // Never follow redirects, never retain error bodies (which may echo secrets).
    if (status !== 200) {
      response.destroy();
      resolve({ status, headers: responseHeaders, data: '' });
      return;
    }
    const encoding = response.headers['content-encoding'];
    const length = response.headers['content-length'];
    if ((encoding !== undefined && encoding.toLowerCase() !== 'identity')
      || (typeof length === 'string' && /^\d+$/.test(length) && Number(length) > maxResponseBytes)) {
      response.destroy();
      reject(new JupiterApiError('invalid_response'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    response.on('data', (chunk: Buffer | string) => {
      if (failed) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxResponseBytes) {
        failed = true;
        response.destroy();
        reject(new JupiterApiError('invalid_response'));
      } else {
        chunks.push(bytes);
      }
    });
    response.on('end', () => {
      if (!failed) resolve({ status, headers: responseHeaders, data: Buffer.concat(chunks, size) });
    });
    response.on('aborted', () => reject(new JupiterApiError('network')));
    response.on('error', () => reject(new JupiterApiError('network')));
  });
  req.on('error', () => reject(new JupiterApiError('network')));
  req.end();
});

export class JupiterTokensClient {
  readonly #apiKey?: string;
  private readonly timeoutMs: number;
  private readonly transport: JupiterTokensTransport;

  constructor(options: JupiterTokensClientOptions = {}) {
    if (!isRecord(options)) throw new JupiterApiError('invalid_response');
    const { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, transport = defaultTransport } = options;
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 4096
      || !apiKey.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(apiKey))) throw new JupiterApiError('invalid_response');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS
      || typeof transport !== 'function') throw new JupiterApiError('invalid_response');
    this.#apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.transport = transport;
  }

  private async get(path: '/tokens/v2/recent' | '/tokens/v2/search', query?: string): Promise<unknown[]> {
    const headers: Record<string, string> = { accept: 'application/json', 'accept-encoding': 'identity' };
    if (this.#apiKey !== undefined) headers['x-api-key'] = this.#apiKey;
    const url = ORIGIN + path + (query === undefined ? '' : `?query=${encodeURIComponent(query)}`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new JupiterApiError('network'));
        }, this.timeoutMs);
      });
      const response = await Promise.race([
        this.transport({ url, method: 'GET', headers, timeoutMs: this.timeoutMs, maxResponseBytes: MAX_BYTES, signal: controller.signal }),
        timeout,
      ]);
      if (!isRecord(response) || !Number.isInteger(response.status)) throw new JupiterApiError('invalid_response');
      if (response.status === 401 || response.status === 403) throw new JupiterApiError('unauthorized');
      if (response.status === 429) throw new JupiterApiError('rate_limited', retryDelay(response.headers));
      if (response.status >= 300 && response.status < 400) throw new JupiterApiError('invalid_response');
      if (response.status !== 200) throw new JupiterApiError('network');
      if (typeof response.data !== 'string' && !(response.data instanceof Uint8Array)) throw new JupiterApiError('invalid_response');
      if ((typeof response.data === 'string' ? Buffer.byteLength(response.data, 'utf8') : response.data.byteLength) > MAX_BYTES) {
        throw new JupiterApiError('invalid_response');
      }
      const bytes = typeof response.data === 'string' ? Buffer.from(response.data, 'utf8') : response.data;
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new JupiterApiError('invalid_response');
      }
      if (!Array.isArray(data)) throw new JupiterApiError('invalid_response');
      return data;
    } catch (error) {
      // Never return a transport exception or its cause/config/message to callers.
      if (error instanceof JupiterApiError) throw new JupiterApiError(error.code, error.retryAfterMs);
      throw new JupiterApiError('network');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  public async recent(): Promise<JupiterToken[]> {
    const rows = await this.get('/tokens/v2/recent');
    const found = new Map<string, JupiterToken>();
    for (const row of rows) {
      const token = parseToken(row);
      if (!token) continue;
      const previous = found.get(token.mint);
      if (previous && JSON.stringify(previous) !== JSON.stringify(token)) throw new JupiterApiError('invalid_response');
      if (!previous) found.set(token.mint, token);
    }
    return [...found.values()];
  }

  public async searchByMints(mints: string[]): Promise<Map<string, JupiterToken>> {
    // Validate the complete input before any I/O; symbols and noncanonical addresses are rejected.
    if (!Array.isArray(mints)) throw new JupiterApiError('invalid_response');
    for (const mint of mints) if (!canonicalAddress(mint)) throw new JupiterApiError('invalid_response');
    const unique = [...new Set(mints)];
    const found = new Map<string, JupiterToken>();
    for (let offset = 0; offset < unique.length; offset += MAX_BATCH) {
      const batch = unique.slice(offset, offset + MAX_BATCH);
      const requested = new Set(batch);
      const rows = await this.get('/tokens/v2/search', batch.join(','));
      for (const row of rows) {
        // Do not parse or propagate data for an unrequested mint, even from another batch.
        if (!isRecord(row) || !canonicalAddress(row.id) || !requested.has(row.id)) continue;
        const token = parseToken(row);
        if (!token) continue;
        const previous = found.get(token.mint);
        if (previous && JSON.stringify(previous) !== JSON.stringify(token)) throw new JupiterApiError('invalid_response');
        if (!previous) found.set(token.mint, token);
      }
    }
    return found;
  }
}
