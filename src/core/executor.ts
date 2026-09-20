import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey
} from '@solana/web3.js';
import fetch from 'cross-fetch';
import pino from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

export class SwapExecutor {
  private connection: Connection;
  private wallet: Keypair;

  constructor(connection: Connection, wallet: Keypair) {
    this.connection = connection;
    this.wallet = wallet;
  }

  /**
   * Prépare une transaction de swap via Jupiter V6
   */
  public async prepareBuyTransaction(tokenMint: string, amountInSol: number, slippageBps: number = 1500): Promise<VersionedTransaction | null> {
    try {
      const amountInLamports = Math.floor(amountInSol * 10**9);
      // Utilisation de l'API Jupiter V6
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenMint}&amount=${amountInLamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;

      const quoteResponse = await fetch(quoteUrl);
      const quoteData = await quoteResponse.json();

      if (quoteData.error || !quoteData.routePlan) {
        logger.warn(`Pas de route trouvée pour ${tokenMint} : ${quoteData.error || 'RoutePlan vide'}`);
        return null;
      }

      const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quoteData,
          userPublicKey: this.wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          computeUnitPriceMicroLamports: 100000, // Priorité haute
          dynamicComputeUnitLimit: true,
        }),
      });

      const swapResult = await swapResponse.json();
      if (!swapResult.swapTransaction) {
        throw new Error('Échec de la génération de la transaction de swap');
      }

      const transaction = VersionedTransaction.deserialize(Buffer.from(swapResult.swapTransaction, 'base64'));
      transaction.sign([this.wallet]);

      return transaction;
    } catch (error: any) {
      logger.error(`Erreur préparation swap: ${error.message}`);
      return null;
    }
  }

  /**
   * Exécute l'achat via RPC standard avec confirmation
   */
  public async buyToken(tokenMint: string, amountInSol: number, slippageBps: number = 1500) {
    const transaction = await this.prepareBuyTransaction(tokenMint, amountInSol, slippageBps);
    if (!transaction) return null;

    try {
      logger.info('Envoi de la transaction via RPC standard...');
      const txid = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });

      logger.info(`Transaction envoyée : ${txid}. Attente de confirmation...`);

      // Confirmation asynchrone pour ne pas bloquer le bot
      this.connection.confirmTransaction(txid, 'confirmed').then((res) => {
        if (res.value.err) {
          logger.error(`Échec confirmation TX ${txid}: ${JSON.stringify(res.value.err)}`);
        } else {
          logger.info(`Achat confirmé ! https://solscan.io/tx/${txid}`);
        }
      });

      return txid;
    } catch (error: any) {
      logger.error(`Erreur lors de l'envoi du swap: ${error.message}`);
      return null;
    }
  }
}
