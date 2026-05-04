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
   * Prépare une transaction de swap sans l'envoyer (utile pour Jito)
   */
  public async prepareBuyTransaction(tokenMint: string, amountInSol: number, slippageBps: number = 1500): Promise<VersionedTransaction | null> {
    try {
      const amountInLamports = Math.floor(amountInSol * 10**9);
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenMint}&amount=${amountInLamports}&slippageBps=${slippageBps}`;
      
      const quoteResponse = await fetch(quoteUrl);
      const quoteData = await quoteResponse.json();

      if (quoteData.error) throw new Error(`Jupiter Quote Error: ${quoteData.error}`);

      const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quoteData,
          userPublicKey: this.wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto'
        }),
      });

      const { swapTransaction } = await swapResponse.json();
      const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
      transaction.sign([this.wallet]);

      return transaction;
    } catch (error) {
      logger.error(`Erreur préparation swap: ${error}`);
      return null;
    }
  }

  public async buyToken(tokenMint: string, amountInSol: number, slippageBps: number = 1500) {
    const transaction = await this.prepareBuyTransaction(tokenMint, amountInSol, slippageBps);
    if (!transaction) return null;

    try {
      logger.info('Envoi de la transaction via RPC standard...');
      const txid = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 2,
      });
      return txid;
    } catch (error) {
      logger.error(`Erreur envoi swap: ${error}`);
      return null;
    }
  }
}
