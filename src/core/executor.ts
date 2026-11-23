import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import fetch from 'cross-fetch';
import bs58 from 'bs58';
import pino from 'pino';
import { assertLiveExecutionAvailable } from '../security.js';

const logger = pino({ transport: { target: 'pino-pretty' } });
const WSOL = 'So11111111111111111111111111111111111111112';
const JUPITER_API = 'https://api.jup.ag/swap/v1';

export interface PreparedSwap {
  transaction: VersionedTransaction;
  lastValidBlockHeight: number;
}

interface ExecutorOptions {
  apiKey: string;
  fetcher?: typeof fetch;
}

function positiveIntegerString(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9]+$/.test(value) && BigInt(value) > 0n;
}

export class SwapExecutor {
  private readonly fetcher: typeof fetch;
  constructor(private readonly connection: Connection, private readonly wallet: Keypair, private readonly options: ExecutorOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  /** Prépare et signe le swap ; aucun envoi n'est effectué ici. */
  public async prepareBuyTransaction(tokenMint: string, amountInSol: number, slippageBps = 1500, forJitoBundle = false): Promise<PreparedSwap | null> {
    try {
      // Le quote ne prouve pas que la transaction correspond à l'ordre demandé.
      assertLiveExecutionAvailable();
      const mint = new PublicKey(tokenMint).toBase58();
      if (mint === WSOL) throw new Error('Le token de sortie ne peut pas être WSOL');
      const amountInLamports = Math.round(amountInSol * 1_000_000_000);
      if (!Number.isFinite(amountInSol) || amountInSol <= 0 || !Number.isSafeInteger(amountInLamports) || amountInLamports < 1) {
        throw new Error('Montant SOL invalide');
      }
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
        throw new Error('Slippage invalide');
      }
      if (!this.options.apiKey.trim()) throw new Error('JUPITER_API_KEY manquante');
      const params = new URLSearchParams({
        inputMint: WSOL, outputMint: mint, amount: String(amountInLamports),
        slippageBps: String(slippageBps), onlyDirectRoutes: 'false',
        ...(forJitoBundle ? { forJitoBundle: 'true' } : {}),
      });
      const headers = { 'x-api-key': this.options.apiKey };
      const quoteResponse = await this.fetcher(`${JUPITER_API}/quote?${params}`, {
        headers, signal: AbortSignal.timeout(8000),
      });
      if (!quoteResponse.ok) throw new Error(`Jupiter quote HTTP ${quoteResponse.status}`);
      const quoteData = await quoteResponse.json() as Record<string, unknown>;
      if (!quoteData || quoteData.inputMint !== WSOL || quoteData.outputMint !== mint ||
          quoteData.inAmount !== String(amountInLamports) || quoteData.swapMode !== 'ExactIn' ||
          quoteData.slippageBps !== slippageBps || !positiveIntegerString(quoteData.outAmount) ||
          !positiveIntegerString(quoteData.otherAmountThreshold) || !Array.isArray(quoteData.routePlan) ||
          quoteData.routePlan.length === 0) {
        throw new Error('Réponse Jupiter quote incorrecte ou incohérente');
      }
      const swapResponse = await this.fetcher(`${JUPITER_API}/swap`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: this.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: { priorityLevelWithMaxLamports: { priorityLevel: 'high', maxLamports: 1_000_000 } },
        }),
      });
      if (!swapResponse.ok) throw new Error(`Jupiter swap HTTP ${swapResponse.status}`);
      const result = await swapResponse.json() as Record<string, unknown>;
      if (typeof result.swapTransaction !== 'string' || !result.swapTransaction ||
          !Number.isSafeInteger(result.lastValidBlockHeight) || (result.lastValidBlockHeight as number) <= 0 ||
          result.simulationError) {
        throw new Error('Réponse Jupiter swap incomplète ou simulation échouée');
      }
      const transaction = VersionedTransaction.deserialize(Buffer.from(result.swapTransaction, 'base64'));
      if (transaction.message.header.numRequiredSignatures !== 1 ||
          !transaction.message.staticAccountKeys[0]?.equals(this.wallet.publicKey)) {
        throw new Error('Payeur ou signataires de la transaction Jupiter inattendus');
      }
      transaction.sign([this.wallet]);
      return { transaction, lastValidBlockHeight: result.lastValidBlockHeight as number };
    } catch (error: unknown) {
      logger.error(`Erreur préparation swap: ${error instanceof Error ? error.message : 'erreur inconnue'}`);
      return null;
    }
  }

  /** Renvoie la signature uniquement après confirmation sans erreur ; aucune nouvelle tentative de swap. */
  public async buyToken(tokenMint: string, amountInSol: number, slippageBps = 1500): Promise<string | null> {
    try {
      // Vérification indépendante : même une préparation remplacée ne peut pas soumettre.
      assertLiveExecutionAvailable();
    } catch (error: unknown) {
      logger.error(`Achat désactivé : ${error instanceof Error ? error.message : 'erreur inconnue'}`);
      return null;
    }
    const prepared = await this.prepareBuyTransaction(tokenMint, amountInSol, slippageBps);
    if (!prepared) return null;
    const { transaction, lastValidBlockHeight } = prepared;
    const signature = bs58.encode(transaction.signatures[0]!);
    try {
      const returnedSignature = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0,
      });
      if (returnedSignature !== signature) throw new Error('Signature RPC inattendue');
      logger.info(`Transaction soumise : ${signature}. Attente de confirmation...`);
      const confirmation = await this.connection.confirmTransaction({
        signature, blockhash: transaction.message.recentBlockhash, lastValidBlockHeight,
      }, 'confirmed');
      if (confirmation.value.err) {
        logger.error(`Transaction échouée ${signature}: ${JSON.stringify(confirmation.value.err)}`);
        return null;
      }
      logger.info(`Achat confirmé : https://solscan.io/tx/${signature}`);
      return signature;
    } catch (error: unknown) {
      // Une panne réseau peut arriver après l'envoi : ne pas construire un deuxième achat.
      logger.error(`Statut du swap inconnu ou échec avant envoi. Vérifier ${signature} avant toute nouvelle tentative : ${error instanceof Error ? error.message : 'erreur inconnue'}`);
      return null;
    }
  }
}
