import { Connection, Keypair } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import bs58 from 'bs58';
import pino from 'pino';
import { PoolMonitor } from './core/monitor.js';
import { SwapExecutor } from './core/executor.js';
import { Excavator } from './core/excavator.js';
import { JitoExecutor } from './core/jito.js';

dotenv.config();

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

async function main() {
  logger.info('Initialisation du Sniper Bot Solana...');

  const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  const wsUrl = process.env.WS_URL || 'wss://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, {
    wsEndpoint: wsUrl,
    commitment: 'confirmed',
  });

  if (!process.env.PRIVATE_KEY) {
    logger.error('Erreur : PRIVATE_KEY manquante dans le fichier .env');
    process.exit(1);
  }

  const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
  logger.info(`Wallet chargé : ${wallet.publicKey.toString()}`);

  const monitor = new PoolMonitor(connection);
  const executor = new SwapExecutor(connection, wallet);
  const excavator = new Excavator();
  
  const useJito = process.env.USE_JITO === 'true';
  const jitoExecutor = useJito ? new JitoExecutor(connection, wallet, process.env.JITO_BLOCK_ENGINE_URL || 'frankfurt.mainnet.block-engine.jito.wtf') : null;

  const buyAmount = parseFloat(process.env.BUY_AMOUNT || '0.1');
  const slippage = parseInt(process.env.SLIPPAGE || '15') * 100;
  const jitoTip = parseFloat(process.env.JITO_TIP || '0.001') * 10**9;

  await monitor.start(async (tokenMint, poolId) => {
    logger.info(`--- Nouveau Token Détecté : ${tokenMint} ---`);
    
    // Phase Excavator : Analyse de sécurité
    const report = await excavator.analyzeToken(tokenMint);
    if (!report.isSafe) {
      logger.warn(`Token rejeté par Excavator. Raisons : ${report.risks.join(', ')}`);
      return;
    }
    logger.info('Token validé par Excavator. Lancement de l\'achat...');

    // Phase Exécution
    if (useJito && jitoExecutor) {
      const transaction = await executor.prepareBuyTransaction(tokenMint, buyAmount, slippage);
      if (transaction) {
        const bundleId = await jitoExecutor.sendBundle([transaction], jitoTip);
        if (bundleId) logger.info(`Achat via Jito Bundle réussi. ID: ${bundleId}`);
      }
    } else {
      const txid = await executor.buyToken(tokenMint, buyAmount, slippage);
      if (txid) logger.info(`Achat via RPC standard réussi. TXID: ${txid}`);
    }
  });
}

main().catch(err => {
  logger.error(`Erreur fatale : ${err}`);
});
