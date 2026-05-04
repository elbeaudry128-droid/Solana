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
          this.processNewPool(signature, callback);
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

      if (!transaction) return;

      // Logique simplifiée pour extraire le mint du token
      // Dans un vrai bot, on analyserait les comptes de l'instruction initialize2
      const accounts = transaction.transaction.message.accountKeys.map(k => k.pubkey.toString());
      
      // L'adresse du pool et des tokens se trouvent dans les comptes de l'instruction
      // Pour Raydium V4 initialize2, le token mint est généralement à un index spécifique
      // Ceci est une version simplifiée, l'analyse précise nécessite de parser l'instruction
      
      logger.info('Analyse de la transaction pour extraire les informations du pool...');
      
      // Exemple : on cherche le token qui n'est pas du SOL/USDC/USDT
      const knownMints = [
        'So11111111111111111111111111111111111111112', // SOL
        'EPjFW38Ro2zMLen87GVxcWB85Lisbx1EtMSfgNVdqMdg', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      ];

      // Cette partie nécessite une analyse plus fine des instructions pour être 100% fiable
      // Pour cet exemple, nous simulons la détection
      // callback(tokenMint, poolId);
    } catch (error) {
      logger.error(`Erreur lors du traitement du nouveau pool: ${error}`);
    }
  }
}
