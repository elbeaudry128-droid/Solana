import { Connection, PublicKey } from '@solana/web3.js';
import type { ParsedInstruction, PartiallyDecodedInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import pino from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

const RAYDIUM_LIQUIDITY_PROGRAM_ID_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const INITIALIZE2_TAG = 1;
// tag + nonce + three u64s; the on-chain unpacker accepts trailing bytes.
const INITIALIZE2_MIN_DATA_LENGTH = 26;
const INITIALIZE2_MIN_ACCOUNTS = 21;
const SIGNATURE_CACHE_LIMIT = 10_000;

type PoolCallback = (tokenMint: string, poolId: string) => void | Promise<void>;
type Pool = { tokenMint: string; poolId: string };

/** Decode the instruction's accounts, not the transaction-wide accountKeys. */
function parseInitialize2(instruction: ParsedInstruction | PartiallyDecodedInstruction): Pool | null {
  try {
    if (!instruction.programId.equals(RAYDIUM_LIQUIDITY_PROGRAM_ID_V4)) return null;
    // jsonParsed RPC returns unknown Raydium instructions in this form. If an RPC
    // instead returns a parsed instruction without raw data/accounts, fail closed.
    if (!('data' in instruction) || !('accounts' in instruction)) return null;
    const data = bs58.decode(instruction.data);
    if (data.length < INITIALIZE2_MIN_DATA_LENGTH || data[0] !== INITIALIZE2_TAG) return null;
    if (instruction.accounts.length < INITIALIZE2_MIN_ACCOUNTS) return null;

    const poolId = instruction.accounts[4]?.toBase58();
    const mintA = instruction.accounts[8]?.toBase58();
    const mintB = instruction.accounts[9]?.toBase58();
    if (!poolId || !mintA || !mintB) return null;
    if ((mintA === WSOL_MINT) === (mintB === WSOL_MINT)) return null;

    return { poolId, tokenMint: mintA === WSOL_MINT ? mintB : mintA };
  } catch {
    // Invalid base58 or malformed instructions must not trigger a purchase.
    return null;
  }
}

export class PoolMonitor {
  private connection: Connection;
  private subscriptionId: number | undefined;
  private readonly processingSignatures = new Set<string>();
  private readonly processedSignatures = new Set<string>();
  private readonly processedPools = new Set<string>();

  constructor(connection: Connection) {
    this.connection = connection;
  }

  public async start(callback: PoolCallback): Promise<void> {
    if (this.subscriptionId !== undefined) return;
    logger.info('Démarrage de la surveillance des nouveaux pools Raydium...');

    this.subscriptionId = this.connection.onLogs(
      RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
      async ({ err, signature, logs }) => {
        if (err || this.processingSignatures.has(signature) || this.processedSignatures.has(signature)) return;
        // The Raydium processor logs "initialize2". Do not trust this as proof:
        // always validate the instruction, and inspect absent/truncated logs too.
        if (logs?.length && !logs.some(log => log.includes('initialize2') || log.includes('Log truncated'))) return;
        this.processingSignatures.add(signature);
        try {
          await this.processNewPool(signature, callback);
        } catch {
          // Do not log RPC error objects: their messages can contain endpoint credentials.
          logger.error({ signature }, 'Erreur lors du traitement de la transaction Raydium');
        } finally {
          this.processingSignatures.delete(signature);
        }
      },
      'confirmed'
    );
  }

  private async processNewPool(signature: string, callback: PoolCallback): Promise<void> {
    const transaction = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    // Do not permanently suppress a signature if RPC data is temporarily unavailable.
    if (!transaction || !transaction.meta) return;
    this.processedSignatures.add(signature);
    if (this.processedSignatures.size > SIGNATURE_CACHE_LIMIT) {
      const oldest = this.processedSignatures.values().next().value;
      if (oldest !== undefined) this.processedSignatures.delete(oldest);
    }
    if (transaction.meta.err) return;

    const instructions = [
      ...transaction.transaction.message.instructions,
      ...(transaction.meta.innerInstructions ?? []).flatMap(group => group.instructions),
    ];

    for (const instruction of instructions) {
      const pool = parseInitialize2(instruction);
      if (!pool || this.processedPools.has(pool.poolId)) continue;
      // Mark before awaiting the callback. A failed callback may already have sent
      // an order, so retrying it automatically could cause a duplicate purchase.
      this.processedPools.add(pool.poolId);
      logger.info({ tokenMint: pool.tokenMint, poolId: pool.poolId }, 'Pool Raydium identifié');
      try {
        await callback(pool.tokenMint, pool.poolId);
      } catch {
        logger.error({ signature, poolId: pool.poolId }, 'Erreur du callback de pool');
      }
    }
  }
}
