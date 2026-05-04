"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SwapExecutor = void 0;
const web3_js_1 = require("@solana/web3.js");
const cross_fetch_1 = __importDefault(require("cross-fetch"));
const pino_1 = __importDefault(require("pino"));
const logger = (0, pino_1.default)({
    transport: {
        target: 'pino-pretty',
    },
});
class SwapExecutor {
    connection;
    wallet;
    constructor(connection, wallet) {
        this.connection = connection;
        this.wallet = wallet;
    }
    async buyToken(tokenMint, amountInSol, slippageBps = 1500) {
        try {
            const amountInLamports = amountInSol * 10 ** 9;
            const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenMint}&amount=${amountInLamports}&slippageBps=${slippageBps}`;
            logger.info(`Récupération du quote Jupiter pour ${tokenMint}...`);
            const quoteResponse = await (0, cross_fetch_1.default)(quoteUrl);
            const quoteData = await quoteResponse.json();
            if (quoteData.error) {
                throw new Error(`Erreur Jupiter Quote: ${quoteData.error}`);
            }
            logger.info('Préparation de la transaction de swap...');
            const swapResponse = await (0, cross_fetch_1.default)('https://quote-api.jup.ag/v6/swap', {
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
            // Désérialiser et signer la transaction
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = web3_js_1.VersionedTransaction.deserialize(swapTransactionBuf);
            transaction.sign([this.wallet]);
            logger.info('Envoi de la transaction...');
            const txid = await this.connection.sendRawTransaction(transaction.serialize(), {
                skipPreflight: true,
                maxRetries: 2,
            });
            logger.info(`Transaction envoyée ! ID: ${txid}`);
            const confirmation = await this.connection.confirmTransaction(txid, 'confirmed');
            if (confirmation.value.err) {
                throw new Error(`Échec de la confirmation: ${JSON.stringify(confirmation.value.err)}`);
            }
            logger.info(`Achat réussi : https://solscan.io/tx/${txid}`);
            return txid;
        }
        catch (error) {
            logger.error(`Erreur lors de l'exécution du swap: ${error}`);
            return null;
        }
    }
}
exports.SwapExecutor = SwapExecutor;
//# sourceMappingURL=executor.js.map