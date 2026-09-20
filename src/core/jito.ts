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
  private searcher: any;

  constructor(connection: Connection, wallet: Keypair, blockEngineUrl: string) {
    this.connection = connection;
    this.wallet = wallet;
    try {
      this.searcher = searcherClient(blockEngineUrl, wallet);
    } catch (e) {
      logger.error(`Échec de l'initialisation du client Jito Searcher: ${e}`);
    }
  }

  public async sendBundle(transactions: VersionedTransaction[], tipAmountLamports: number) {
    if (!this.searcher) {
      logger.error('Client Jito non initialisé.');
      return null;
    }

    try {
      const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
      const { blockhash } = await this.connection.getLatestBlockhash('finalized');

      const tipIxn = SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: tipAccount,
        lamports: Math.floor(tipAmountLamports),
      });

      const messageV0 = new TransactionMessage({
        payerKey: this.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [tipIxn],
      }).compileToV0Message();

      const tipTx = new VersionedTransaction(messageV0);
      tipTx.sign([this.wallet]);

      const bundle = new Bundle([...transactions, tipTx], 5);

      const result = await this.searcher.sendBundle(bundle);

      // La réponse de Jito peut être un objet Result (ok/err)
      if (result.ok) {
        const bundleId = result.ok;
        logger.info(`Bundle Jito envoyé ! ID: ${bundleId}`);

        // Suivi optionnel du résultat du bundle
        this.searcher.onBundleResult(
          (bundleResult: any) => {
            logger.info(`Résultat Bundle ${bundleId}: ${JSON.stringify(bundleResult)}`);
          },
          (err: any) => {
            logger.error(`Erreur suivi Bundle ${bundleId}: ${err}`);
          }
        );

        return bundleId;
      } else {
        logger.error(`Échec de l'envoi du Bundle Jito: ${JSON.stringify(result.err)}`);
        return null;
      }
    } catch (error: any) {
      logger.error(`Exception lors de l'envoi du Bundle Jito: ${error.message}`);
      return null;
    }
  }
}
