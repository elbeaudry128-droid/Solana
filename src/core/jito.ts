import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { searcher } from 'jito-ts';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types.js';
import pino from 'pino';
import { assertLiveExecutionAvailable } from '../security.js';

const { searcherClient } = searcher;
const logger = pino({ transport: { target: 'pino-pretty' } });

// A separate, unconditional tip transaction can be rebroadcast on its own after
// an uncled block. Only a single Jupiter swap with an in-transaction tip is used.
const JUPITER_V6_PROGRAM = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const MIN_TIP_LAMPORTS = 1_000;
const MAX_TIP_LAMPORTS = 5_000_000; // 0.005 SOL per transaction, fail closed.
const OFFICIAL_ENGINE = /^(?:[a-z0-9-]+\.)?mainnet\.block-engine\.jito\.wtf(?::443)?$/i;

type SearcherClient = ReturnType<typeof searcherClient>;

export class JitoExecutor {
  private readonly connection: Connection;
  private readonly wallet: Keypair;
  private readonly searcher: SearcherClient | null;

  constructor(connection: Connection, wallet: Keypair, blockEngineUrl: string) {
    this.connection = connection;
    this.wallet = wallet;
    let client: SearcherClient | null = null;
    try {
      if (!OFFICIAL_ENGINE.test(blockEngineUrl)) {
        throw new Error('Block engine non officiel');
      }
      // Jito's public endpoints do not require an authentication keypair.
      client = searcherClient(blockEngineUrl);
    } catch {
      logger.error('Échec de l’initialisation du client Jito ou endpoint non officiel.');
    }
    this.searcher = client;
  }

  /**
   * Returns the bundle ID only after its sole transaction is confirmed on-chain.
   * A null result can mean failure OR an unknown outcome; do not retry until the
   * transaction signature has been reconciled. No result-stream is subscribed.
   * When available, pass Jupiter's lastValidBlockHeight for expiry-aware confirmation.
   */
  public async sendBundle(transactions: VersionedTransaction[], tipAmountLamports: number, lastValidBlockHeight?: number): Promise<string | null> {
    assertLiveExecutionAvailable();
    if (!this.searcher) {
      logger.error('Client Jito non initialisé.');
      return null;
    }
    if (!Array.isArray(transactions) || transactions.length !== 1 || !(transactions[0] instanceof VersionedTransaction)) {
      logger.error('Mode tips autonomes ou bundles multiples indisponible : un seul swap Jupiter est requis.');
      return null;
    }
    if (!Number.isSafeInteger(tipAmountLamports) || tipAmountLamports < MIN_TIP_LAMPORTS || tipAmountLamports > MAX_TIP_LAMPORTS) {
      logger.error('Montant du tip invalide ou supérieur à la limite de sécurité.');
      return null;
    }
    if (lastValidBlockHeight !== undefined && (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0)) {
      logger.error('Hauteur d’expiration invalide.');
      return null;
    }

    let signature: string | undefined;
    try {
      const original = transactions[0];
      if (original.message.header.numRequiredSignatures !== 1 || !original.message.staticAccountKeys[0]?.equals(this.wallet.publicKey)) {
        throw new Error('Signataire ou payeur non pris en charge');
      }

      const tables: AddressLookupTableAccount[] = [];
      if (original.message.version === 0) {
        for (const lookup of original.message.addressTableLookups) {
          const response = await this.connection.getAddressLookupTable(lookup.accountKey);
          if (!response.value || !response.value.isActive()) throw new Error('Table d’adresses indisponible');
          tables.push(response.value);
        }
      }
      const message = TransactionMessage.decompile(original.message, { addressLookupTableAccounts: tables });
      if (!message.instructions.some(ix => ix.programId.equals(JUPITER_V6_PROGRAM))) {
        throw new Error('Instruction Jupiter absente');
      }

      const tipResult = await this.searcher.getTipAccounts();
      if (!tipResult.ok || !Array.isArray(tipResult.value) || tipResult.value.length === 0) {
        throw new Error('Comptes de tip indisponibles');
      }
      const tipAccounts = tipResult.value.map(value => {
        if (typeof value !== 'string') throw new Error('Compte de tip invalide');
        const key = new PublicKey(value);
        if (key.toBase58() !== value) throw new Error('Compte de tip non canonique');
        return key;
      }).filter(key => !key.equals(this.wallet.publicKey)
        && !key.equals(SystemProgram.programId)
        // Adding a writable tip must not alter privileges of an existing account.
        && !message.instructions.some(ix => ix.programId.equals(key) || ix.keys.some(meta => meta.pubkey.equals(key)))
        // Jito requires the tip account to be a static account, not an ALT entry.
        && !tables.some(table => table.state.addresses.some(address => address.equals(key))));
      if (tipAccounts.length === 0) throw new Error('Aucun compte de tip admissible');
      const tipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)]!;
      message.instructions.push(SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: tipAccount,
        lamports: tipAmountLamports,
      }));

      const newMessage = original.message.version === 0
        ? message.compileToV0Message(tables)
        : message.compileToLegacyMessage();
      const transaction = new VersionedTransaction(newMessage);
      transaction.sign([this.wallet]);
      if (transaction.serialize().length > PACKET_DATA_SIZE) throw new Error('Transaction trop volumineuse');
      signature = bs58.encode(transaction.signatures[0]!);

      // The original Jupiter simulation did not include the new tip instruction.
      const simulation = await this.connection.simulateTransaction(transaction, {
        commitment: 'confirmed',
        sigVerify: true,
      });
      if (simulation.value.err) throw new Error('Simulation de la transaction échouée');

      const result = await this.searcher.sendBundle(new Bundle([transaction], 1));
      if (!result.ok) {
        const code = Number.isSafeInteger(result.error?.code) ? ` (code ${result.error.code})` : '';
        logger.error(`Échec ou résultat incertain de la soumission Jito${code}; signature ${signature}. Réconcilier avant toute nouvelle tentative.`);
        return null;
      }
      if (typeof result.value !== 'string' || !result.value.trim()) {
        logger.error(`Réponse Jito invalide; statut inconnu: signature ${signature}. Réconcilier avant toute nouvelle tentative.`);
        return null;
      }
      const bundleId = result.value;
      logger.info(`Bundle Jito soumis, non confirmé. ID: ${bundleId}; signature: ${signature}`);

      // RPC confirmation, not Jito's acceptance or stream event, determines success.
      try {
        const confirmation = lastValidBlockHeight === undefined
          ? await this.connection.confirmTransaction(signature, 'confirmed')
          : await this.connection.confirmTransaction({
            signature, blockhash: transaction.message.recentBlockhash, lastValidBlockHeight,
          }, 'confirmed');
        if (confirmation.value.err) {
          logger.error(`Transaction Jito échouée sur chaîne: ${signature}`);
          return null;
        }
        logger.info(`Transaction Jito confirmée: ${signature}`);
        return bundleId;
      } catch {
        logger.warn(`Confirmation Jito indisponible; statut inconnu: bundle ${bundleId}, signature ${signature}. Ne pas réessayer avant réconciliation.`);
        return null;
      }
    } catch {
      logger.error(signature
        ? `Erreur Jito; vérifier le statut de la signature ${signature} avant nouvelle tentative.`
        : 'Échec de la préparation sécurisée du bundle Jito.');
      return null;
    }
  }
}
