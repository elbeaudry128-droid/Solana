import { Connection, PublicKey } from '@solana/web3.js';
import pino from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

const RAYDIUM_LIQUIDITY_PROGRAM_ID_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

export class PoolMonitor {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  public async start(callback: (tokenMint: string, poolId: string) => void) {
    logger.info('Démarrage de la surveillance des nouveaux pools Raydium...');

    this.connection.onLogs(
      RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
      async ({ logs, err, signature }) => {
        if (err) return;

        if (logs && logs.some(log => log.includes('initialize2'))) {
          logger.info(`Nouveau pool détecté ! Signature: ${signature}`);
          await this.processNewPool(signature, callback);
        }
      },
      'confirmed'
    );
  }

  private async processNewPool(signature: string, callback: (tokenMint: string, poolId: string) => void) {
    try {
      const transaction = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!transaction || !transaction.meta) return;

      // Dans Raydium V4 initialize2, les comptes sont structurés de manière prévisible
      // On cherche les instructions du programme Raydium
      const innerInstructions = transaction.meta.innerInstructions;
      const accountKeys = transaction.transaction.message.accountKeys;

      // Extraction du poolId et des tokens
      // Pour Raydium V4, le poolId est souvent le compte index 4 dans l'instruction initialize2
      // Les tokens sont aux index 8 et 9

      // Analyse plus robuste : on cherche les mints dans les postTokenBalances
      const postTokenBalances = transaction.meta.postTokenBalances || [];
      const mints = postTokenBalances
        .map(b => b.mint)
        .filter(m => m !== 'So11111111111111111111111111111111111111112'); // Exclure le WSOL

      if (mints.length > 0) {
        const tokenMint = mints[0]!;
        const poolId = accountKeys[4]?.pubkey.toString() || 'unknown';
        logger.info(`Token identifié : ${tokenMint} | Pool : ${poolId}`);
        callback(tokenMint, poolId);
      }
    } catch (error) {
      logger.error(`Erreur lors du traitement du nouveau pool: ${error}`);
    }
  }
}
