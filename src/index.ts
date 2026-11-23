import { pathToFileURL } from 'node:url';
import { Connection, Keypair } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import bs58 from 'bs58';
import pino from 'pino';
import { PoolMonitor } from './core/monitor.js';
import { Excavator } from './core/excavator.js';
import { ConfigError, loadConfig } from './config.js';

async function main(): Promise<void> {
  const logger = pino({ transport: { target: 'pino-pretty' } });
  dotenv.config({ quiet: true });

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error(error instanceof ConfigError ? error.message : 'Erreur de configuration.');
    process.exitCode = 1;
    return;
  }

  let wallet: Keypair | undefined;
  if (!config.dryRun) {
    try {
      wallet = Keypair.fromSecretKey(bs58.decode(config.privateKey));
    } catch {
      // Never print the key or the raw exception.
      logger.error('PRIVATE_KEY doit être une clé secrète Solana valide encodée en base58.');
      process.exitCode = 1;
      return;
    }
  }

  const connection = new Connection(config.rpcUrl, {
    ...(config.wsUrl ? { wsEndpoint: config.wsUrl } : {}),
    commitment: 'confirmed',
  });
  const monitor = new PoolMonitor(connection);
  const excavator = new Excavator();
  let executor: import('./core/executor.js').SwapExecutor | undefined;
  let jitoExecutor: import('./core/jito.js').JitoExecutor | undefined;

  if (!config.dryRun && wallet) {
    const { SwapExecutor } = await import('./core/executor.js');
    executor = new SwapExecutor(connection, wallet, { apiKey: config.jupiterApiKey });
    if (config.useJito) {
      const { JitoExecutor } = await import('./core/jito.js');
      jitoExecutor = new JitoExecutor(connection, wallet, config.jitoBlockEngineUrl);
    }
    logger.warn('Mode réel activé : des achats automatiques peuvent être envoyés.');
  } else {
    logger.info('Mode observation : aucune transaction ne sera construite, signée ou envoyée.');
  }

  await monitor.start(async (tokenMint, poolId) => {
    try {
      logger.info(`Pool détecté : ${poolId} | token : ${tokenMint}`);
      const report = await excavator.analyzeToken(tokenMint);
      if (!report.isSafe) {
        logger.warn(`Token rejeté par l’analyse limitée : ${report.risks.join(', ')}`);
        return;
      }
      logger.info('Aucun risque bloquant relevé par l’analyse limitée ; cela ne garantit pas la sécurité du token.');

      if (config.dryRun) {
        logger.info('Observation seulement : achat non préparé et non envoyé.');
        return;
      }
      if (!executor) throw new Error('Exécuteur indisponible.');

      if (config.useJito) {
        if (!jitoExecutor) throw new Error('Exécuteur Jito indisponible.');
        const prepared = await executor.prepareBuyTransaction(tokenMint, config.buyAmountSol, config.slippageBps, true);
        if (prepared) {
          // JitoExecutor logs submission as non confirmed before following confirmation.
          await jitoExecutor.sendBundle([prepared.transaction], config.jitoTipLamports, prepared.lastValidBlockHeight);
        }
      } else {
        const txid = await executor.buyToken(tokenMint, config.buyAmountSol, config.slippageBps);
        if (txid) logger.info(`Achat confirmé : ${txid}`);
      }
    } catch {
      // RPC and HTTP errors can embed credentials; keep this log free of raw errors.
      logger.error('Échec du traitement du pool ; aucun succès ne peut être déduit.');
    }
  });
}

// Importing the module must not start the monitor or open a network connection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Erreur fatale au démarrage du bot.');
    process.exitCode = 1;
  });
}
