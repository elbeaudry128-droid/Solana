import type { JupiterToken } from './jupiterTokens.js';

/** `recent` is a Jupiter observation, not a Raydium pool notification. */
export type RecentEvent = {
  source: 'jupiter-recent';
  mint: string;
  poolId?: string;
  baseline: boolean;
  observedAt: number;
  token: JupiterToken;
};

/** `poolId` comes from the Raydium caller, never from Jupiter's firstPool. */
export type EnrichmentEvent = {
  source: 'raydium';
  enrichmentSource: 'jupiter-search';
  mint: string;
  poolId: string;
  observedAt: number;
} & (
  | { status: 'found'; token: JupiterToken }
  | { status: 'unknown'; reason: 'not_found' | 'unauthorized' | 'rate_limited' | 'network' | 'invalid_response' }
);

export type ErrorEvent = {
  source: 'jupiter-recent' | 'jupiter-search' | 'raydium';
  // A request-level error may not refer to an individual mint.
  mint: string | null;
  poolId?: string;
  code: 'unauthorized' | 'rate_limited' | 'network' | 'invalid_response' | 'handler_error' | 'queue_full';
  // Queue overflow is aggregated: only the first rejected pair is identified.
  droppedCount?: number;
};

export type JupiterObservationClient = {
  recent(): Promise<JupiterToken[]>;
  searchByMints(mints: string[]): Promise<Map<string, JupiterToken>>;
};

export type JupiterObservationHandlers = {
  onRecent(event: RecentEvent): void | Promise<void>;
  onEnrichment(event: EnrichmentEvent): void | Promise<void>;
  onError?(event: ErrorEvent): void | Promise<void>;
};

export type JupiterObservationOptions = {
  pollIntervalMs?: number;
  maxQueueSize?: number;
  maxRecentSeen?: number;
  maxRaydiumSeen?: number;
  maxBatchSize?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

type RequestErrorCode = 'unauthorized' | 'rate_limited' | 'network' | 'invalid_response';
type Pending = { key: string; mint: string; poolId: string; inFlight: boolean };
type Overflow = { mint: string; poolId: string; count: number };

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 24;
const MAX_BACKOFF_MS = 60_000;
// Node clamps larger timeouts to 1 ms; wake in chunks instead of retrying early.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function positiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError('Invalid observation option');
  }
  return value;
}

function requestErrorCode(error: unknown): RequestErrorCode {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'unauthorized' || code === 'rate_limited' || code === 'network' || code === 'invalid_response') {
      return code;
    }
  }
  return 'network';
}

function retryAfter(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('retryAfterMs' in error)) return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** FIFO cache. Evicted observations can be emitted again; no timestamp is used for deduplication. */
function remember(cache: Set<string>, key: string, limit: number): void {
  cache.add(key);
  while (cache.size > limit) {
    const oldest = cache.values().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Read-only supplemental observation. No callback here is a trading callback.
 * `/recent` is neither exhaustive nor necessarily current. Its first successful
 * snapshot, including an empty snapshot, is the baseline. Cache eviction can
 * cause an old mint or pool pair to be emitted again.
 *
 * `observeRaydium` accepts events only while started and not auth-suspended.
 * The bounded queue includes requests in flight. Duplicate pending pairs and
 * successfully enriched pairs in the bounded cache are suppressed; unknown
 * pairs may be submitted again. When full, new pairs are dropped and one
 * asynchronous queue_full error reports the first pair and the aggregate count.
 * Stopping discards pending work; it cannot cancel a callback already invoked.
 */
export class JupiterObservation {
  private readonly pollIntervalMs: number;
  private readonly maxQueueSize: number;
  private readonly maxRecentSeen: number;
  private readonly maxRaydiumSeen: number;
  private readonly maxBatchSize: number;
  private readonly now: () => number;
  private readonly observedNow: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly calls: number[] = [];
  private readonly recentSeen = new Set<string>();
  private readonly raydiumSeen = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private running = false;
  private suspended = false;
  private inFlight = false;
  private generation = 0;
  private firstSnapshot = true;
  private nextRecentAt = 0;
  private backoffUntil = 0;
  private rateLimitFailures = 0;
  private timer: unknown = null;
  private timerAt = 0;
  private overflowTimer: unknown = null;
  private overflow: Overflow | null = null;

  constructor(
    private readonly client: JupiterObservationClient,
    private readonly handlers: JupiterObservationHandlers,
    options: JupiterObservationOptions = {},
  ) {
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs, 5_000, 86_400_000);
    this.maxQueueSize = positiveInteger(options.maxQueueSize, 1_000, 100_000);
    this.maxRecentSeen = positiveInteger(options.maxRecentSeen, 10_000, 1_000_000);
    this.maxRaydiumSeen = positiveInteger(options.maxRaydiumSeen, 10_000, 1_000_000);
    this.maxBatchSize = positiveInteger(options.maxBatchSize, 100, 100);
    // A wall-clock adjustment must not bypass the sliding-window limit.
    this.now = options.now ?? (() => performance.now());
    this.observedNow = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.suspended = false;
    this.generation++;
    this.firstSnapshot = true;
    this.recentSeen.clear();
    this.raydiumSeen.clear();
    this.pending.clear();
    this.nextRecentAt = this.now();
    // Keep quota and 429 backoff across stop/start; restarting is not a quota reset.
    this.schedule();
  }

  public stop(): void {
    this.running = false;
    this.suspended = false;
    this.generation++;
    if (this.timer !== null) this.clearTimer(this.timer);
    if (this.overflowTimer !== null) this.clearTimer(this.overflowTimer);
    this.timer = null;
    this.overflowTimer = null;
    this.overflow = null;
    this.pending.clear();
    this.recentSeen.clear();
    this.raydiumSeen.clear();
  }

  public observeRaydium(mint: string, poolId: string): void {
    if (!this.running || this.suspended || typeof mint !== 'string' || !mint.trim() ||
        typeof poolId !== 'string' || !poolId.trim()) return;
    const key = JSON.stringify([mint, poolId]);
    if (this.pending.has(key) || this.raydiumSeen.has(key)) return;
    if (this.pending.size >= this.maxQueueSize) {
      this.reportOverflow(mint, poolId);
      return;
    }
    this.pending.set(key, { key, mint, poolId, inFlight: false });
    this.schedule();
  }

  private reportOverflow(mint: string, poolId: string): void {
    if (this.overflow) {
      this.overflow.count++;
      return;
    }
    this.overflow = { mint, poolId, count: 1 };
    const generation = this.generation;
    this.overflowTimer = this.setTimer(() => {
      this.overflowTimer = null;
      const overflow = this.overflow;
      this.overflow = null;
      if (!overflow || !this.isCurrent(generation)) return;
      this.emitError({ source: 'raydium', code: 'queue_full', mint: overflow.mint, poolId: overflow.poolId, droppedCount: overflow.count });
    }, 0);
  }

  private isCurrent(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  private pruneCalls(now: number): void {
    while (this.calls.length && this.calls[0]! <= now - WINDOW_MS) this.calls.shift();
  }

  private schedule(): void {
    if (!this.running || this.suspended || this.inFlight) return;
    const now = this.now();
    this.pruneCalls(now);
    const hasQueued = Array.from(this.pending.values()).some(item => !item.inFlight);
    let at = hasQueued ? now : Math.max(now, this.nextRecentAt);
    at = Math.max(at, this.backoffUntil);
    if (this.calls.length >= MAX_REQUESTS) at = Math.max(at, this.calls[0]! + WINDOW_MS);
    if (this.timer !== null && this.timerAt <= at) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timerAt = Math.min(at, now + MAX_TIMER_DELAY_MS);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.run();
    }, Math.max(0, this.timerAt - now));
  }

  private run(): void {
    if (!this.running || this.suspended || this.inFlight) return;
    const now = this.now();
    this.pruneCalls(now);
    if (now < this.backoffUntil || this.calls.length >= MAX_REQUESTS) {
      this.schedule();
      return;
    }
    const generation = this.generation;
    const doRecent = now >= this.nextRecentAt;
    const batch = doRecent ? [] : this.takeBatch();
    if (!doRecent && !batch.length) {
      this.schedule();
      return;
    }
    this.calls.push(now);
    this.inFlight = true;
    void this.execute(generation, doRecent, batch);
  }

  private takeBatch(): Pending[] {
    const mints = new Set<string>();
    for (const item of this.pending.values()) {
      if (item.inFlight) continue;
      if (mints.size < this.maxBatchSize) mints.add(item.mint);
    }
    const batch: Pending[] = [];
    for (const item of this.pending.values()) {
      if (!item.inFlight && mints.has(item.mint)) {
        item.inFlight = true;
        batch.push(item);
      }
    }
    return batch;
  }

  private async execute(generation: number, doRecent: boolean, batch: Pending[]): Promise<void> {
    try {
      if (doRecent) {
        const tokens = await this.client.recent();
        if (!this.isCurrent(generation)) return;
        if (!Array.isArray(tokens)) throw { code: 'invalid_response' };
        this.rateLimitFailures = 0;
        this.nextRecentAt = this.now() + this.pollIntervalMs;
        const baseline = this.firstSnapshot;
        this.firstSnapshot = false;
        for (const token of tokens) {
          if (!this.isCurrent(generation)) break;
          if (!token || typeof token.mint !== 'string' || !token.mint || this.recentSeen.has(token.mint)) continue;
          remember(this.recentSeen, token.mint, this.maxRecentSeen);
          const poolId = typeof token.firstPool?.id === 'string' && token.firstPool.id ? token.firstPool.id : undefined;
          const event: RecentEvent = { source: 'jupiter-recent', mint: token.mint, baseline, observedAt: this.observedNow(), token };
          if (poolId !== undefined) event.poolId = poolId;
          this.emitRecent(event);
        }
      } else {
        const mints = [...new Set(batch.map(item => item.mint))];
        const tokens = await this.client.searchByMints(mints);
        if (!this.isCurrent(generation)) return;
        if (!(tokens instanceof Map)) throw { code: 'invalid_response' };
        this.rateLimitFailures = 0;
        for (const item of batch) {
          if (!this.isCurrent(generation)) break;
          this.pending.delete(item.key);
          const token = tokens.get(item.mint);
          const base = { source: 'raydium' as const, enrichmentSource: 'jupiter-search' as const,
            mint: item.mint, poolId: item.poolId, observedAt: this.observedNow() };
          if (token && token.mint === item.mint) {
            remember(this.raydiumSeen, item.key, this.maxRaydiumSeen);
            this.emitEnrichment({ ...base, status: 'found', token });
          } else {
            this.emitEnrichment({ ...base, status: 'unknown', reason: 'not_found' });
          }
        }
      }
    } catch (error: unknown) {
      const code = requestErrorCode(error);
      // A request that finished after stop/start still consumed quota: preserve
      // its server backoff before deciding whether to discard its old callbacks.
      if (code === 'rate_limited') {
        this.rateLimitFailures++;
        const fallback = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(this.rateLimitFailures - 1, 6));
        // The fallback also applies to a reset of zero (e.g. clock skew). Only
        // the fallback is capped; an explicit server reset is never shortened.
        const delay = Math.max(fallback, retryAfter(error) ?? 0);
        this.backoffUntil = Math.max(this.backoffUntil, this.now() + delay);
      }
      if (!this.isCurrent(generation)) {
        // If the same client has since restarted, a late auth failure must not
        // silently turn the new generation into a stream of unauthorized calls.
        if (code === 'unauthorized' && this.running) {
          const currentGeneration = this.generation;
          this.suspended = true;
          this.emitError({ source: doRecent ? 'jupiter-recent' : 'jupiter-search', mint: null, code });
          for (const item of this.pending.values()) {
            if (!this.isCurrent(currentGeneration)) break;
            this.pending.delete(item.key);
            this.emitEnrichment({ source: 'raydium', enrichmentSource: 'jupiter-search', mint: item.mint,
              poolId: item.poolId, observedAt: this.observedNow(), status: 'unknown', reason: 'unauthorized' });
          }
        }
        return;
      }
      if (doRecent) this.nextRecentAt = this.now() + this.pollIntervalMs;
      if (code === 'unauthorized') this.suspended = true;
      if (doRecent) {
        // A failed recent request has no individual mint to identify.
        this.emitError({ source: 'jupiter-recent', mint: null, code });
      } else {
        for (const mint of new Set(batch.map(item => item.mint))) {
          if (!this.isCurrent(generation)) break;
          this.emitError({ source: 'jupiter-search', mint, code });
        }
      }
      for (const item of batch) {
        if (!this.isCurrent(generation)) break;
        this.pending.delete(item.key);
        this.emitEnrichment({ source: 'raydium', enrichmentSource: 'jupiter-search', mint: item.mint,
          poolId: item.poolId, observedAt: this.observedNow(), status: 'unknown', reason: code });
      }
      if (code === 'unauthorized') {
        // No queued item should be mistaken for a successful enrichment.
        for (const item of this.pending.values()) {
          if (!this.isCurrent(generation)) break;
          this.pending.delete(item.key);
          this.emitEnrichment({ source: 'raydium', enrichmentSource: 'jupiter-search', mint: item.mint,
            poolId: item.poolId, observedAt: this.observedNow(), status: 'unknown', reason: 'unauthorized' });
        }
      }
    } finally {
      this.inFlight = false;
      // A stop/start may have happened during the request. The new generation
      // waits for physical completion, so there is never request overlap.
      this.schedule();
    }
  }

  private emitRecent(event: RecentEvent): void {
    this.invoke(() => this.handlers.onRecent(event), { source: event.source, mint: event.mint, code: 'handler_error' });
  }

  private emitEnrichment(event: EnrichmentEvent): void {
    this.invoke(() => this.handlers.onEnrichment(event), { source: 'jupiter-search', mint: event.mint,
      poolId: event.poolId, code: 'handler_error' });
  }

  private invoke(callback: () => void | Promise<void>, error: ErrorEvent): void {
    const generation = this.generation;
    try {
      Promise.resolve(callback()).catch(() => {
        if (this.isCurrent(generation)) this.emitError(error);
      });
    } catch {
      if (this.isCurrent(generation)) this.emitError(error);
    }
  }

  private emitError(event: ErrorEvent): void {
    if (!this.running || !this.handlers.onError) return;
    try {
      // Do not recurse if the error handler itself fails, and never log raw errors.
      Promise.resolve(this.handlers.onError(event)).catch(() => {});
    } catch {
      // Intentionally ignored.
    }
  }
}
