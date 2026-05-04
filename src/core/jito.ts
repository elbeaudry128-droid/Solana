import { 
  Connection, 
  Keypair, 
  VersionedTransaction, 
  PublicKey,
  SystemProgram,
  TransactionMessage
} from '@solana/web3.js';
import { searcher } from 'jito-ts';
const { searcherClient } = searcher;
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types.js';
import pino from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

// Adresses des tips Jito (Block Engine)
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyMvqc17HfJvJkBeGspQUgLYWoY7A4JFzESURBn3',
  'ADaUMid9yfUytqMBqkhpNCq6d35tczmoNgoSgW86oADu',
  'DfXygSm4jCyvBhcJbfuVYG77Nm8czv4BWjzliFshC62C',
  'ADuUkR4vqMvS2neGrUNsYME4Lcyoe2ne6z5kgnHUPkkB',
  'DttWaMuVvTiduRMhb2dC1WicnS8v97fMdgMQsvbt5ebE',
  '3AVi9V95t2DQC6abMDTM9jdAiH8J5tdyqLQ89Vm9D6oG',
].map(pubkey => new PublicKey(pubkey));

export class JitoExecutor {
  private connection: Connection;
  private wallet: Keypair;
  private searcher;

  constructor(connection: Connection, wallet: Keypair, blockEngineUrl: string) {
    this.connection = connection;
    this.wallet = wallet;
    this.searcher = searcherClient(blockEngineUrl, wallet);
  }

  /**
   * Envoie une transaction via un Bundle Jito pour éviter le front-running et garantir la priorité
   */
  public async sendBundle(transactions: VersionedTransaction[], tipAmountLamports: number) {
    try {
      logger.info(`Préparation du Bundle Jito avec un tip de ${tipAmountLamports} lamports...`);

      // Sélectionner un compte de tip aléatoire
      const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;

      // Créer la transaction de tip
      const { blockhash } = await this.connection.getLatestBlockhash();
      const tipIxn = SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: tipAccount,
        lamports: tipAmountLamports,
      });

      const messageV0 = new TransactionMessage({
        payerKey: this.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [tipIxn],
      }).compileToV0Message();

      const tipTx = new VersionedTransaction(messageV0);
      tipTx.sign([this.wallet]);

      // Ajouter la transaction de tip au bundle
      const bundle = new Bundle([...transactions, tipTx], 5);
      
      const bundleId = await this.searcher.sendBundle(bundle);
      logger.info(`Bundle envoyé avec succès ! ID: ${bundleId}`);
      
      return bundleId;
    } catch (error) {
      logger.error(`Erreur lors de l'envoi du Bundle Jito: ${error}`);
      return null;
    }
  }
}
