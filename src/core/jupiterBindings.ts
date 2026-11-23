import type { Config } from '../config.js';
import { JupiterTokensClient } from './jupiterTokens.js';
import {
  JupiterObservation,
  type JupiterObservationClient,
  type JupiterObservationHandlers,
  type JupiterObservationOptions,
} from './jupiterObservation.js';

/** The only permitted outputs of the Jupiter observation path are these logs. */
export type ObservationLogger = {
  info(data: object, message: string): void;
  warn(data: object, message: string): void;
};

export type JupiterObservationHandle = Pick<JupiterObservation, 'start' | 'stop' | 'observeRaydium'>;
export type ObservationFactory = (
  client: JupiterObservationClient,
  handlers: JupiterObservationHandlers,
  options: JupiterObservationOptions,
) => JupiterObservationHandle;

/** The optional factory and client allow offline integration tests without network access. */
export function createJupiterObservation(
  config: Config,
  logger: ObservationLogger,
  dependencies: { client?: JupiterObservationClient; factory?: ObservationFactory } = {},
): JupiterObservationHandle | undefined {
  // This remains independent of the configuration guard in loadConfig. If a
  // future version permits live trading, it must not silently activate this path.
  if (!config.dryRun || !config.jupiterTokensEnabled) return undefined;

  const client = dependencies.client ?? new JupiterTokensClient({ apiKey: config.jupiterTokensApiKey });
  const handlers: JupiterObservationHandlers = {
    onRecent: event => {
      logger.info({
        source: event.source,
        mint: event.mint,
        firstPoolId: event.poolId,
        baseline: event.baseline,
        observedAt: event.observedAt,
        token: event.token,
      }, event.baseline
        ? 'Référence initiale Jupiter : token déjà observé, sans garantie de sécurité.'
        : 'Observation Jupiter : premier pool récemment indexé, sans garantie de sécurité.');
    },
    onEnrichment: event => {
      if (event.status === 'found') {
        logger.info({
          source: event.source,
          enrichmentSource: event.enrichmentSource,
          mint: event.mint,
          poolId: event.poolId,
          observedAt: event.observedAt,
          status: event.status,
          token: event.token,
        }, 'Données Jupiter associées au mint Raydium ; elles ne prouvent pas la sécurité du token.');
      } else {
        logger.warn({
          source: event.source,
          enrichmentSource: event.enrichmentSource,
          mint: event.mint,
          poolId: event.poolId,
          observedAt: event.observedAt,
          status: event.status,
          reason: event.reason,
        }, 'Données Jupiter indisponibles : état inconnu.');
      }
    },
    onError: event => {
      // ErrorEvent carries only a fixed code and non-secret identifiers; never log
      // an HTTP exception, raw response, headers, configuration or credential.
      logger.warn({
        source: event.source,
        mint: event.mint,
        poolId: event.poolId,
        code: event.code,
        droppedCount: event.droppedCount,
      }, 'Observation Jupiter limitée ou indisponible.');
    },
  };
  const options: JupiterObservationOptions = { pollIntervalMs: config.jupiterTokensPollIntervalMs };
  const factory = dependencies.factory ?? ((service, callbacks, opts) => new JupiterObservation(service, callbacks, opts));
  return factory(client, handlers, options);
}

type PoolCallback = (mint: string, poolId: string) => void | Promise<void>;
type PoolMonitorPort = { start(callback: PoolCallback): Promise<void> };

/** Start independent observation before accepting the original pool events. */
export async function startRaydiumWithJupiter(
  monitor: PoolMonitorPort,
  onPool: PoolCallback,
  observation: JupiterObservationHandle | undefined,
  onEnqueueFailure: () => void,
): Promise<void> {
  try {
    observation?.start();
    await monitor.start(async (mint, poolId) => {
      try {
        // Enqueue only; enrichment is asynchronous and never controls onPool.
        observation?.observeRaydium(mint, poolId);
      } catch {
        // A failing logger must not suppress the independent Raydium callback.
        try { onEnqueueFailure(); } catch { /* intentionally ignored */ }
      }
      await onPool(mint, poolId);
    });
  } catch (error) {
    try { observation?.stop(); } catch { /* preserve the original startup error */ }
    throw error;
  }
}
