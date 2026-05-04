"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const web3_js_1 = require("@solana/web3.js");
const dotenv = __importStar(require("dotenv"));
const bs58_1 = __importDefault(require("bs58"));
const pino_1 = __importDefault(require("pino"));
const monitor_1 = require("./core/monitor");
const executor_1 = require("./core/executor");
dotenv.config();
const logger = (0, pino_1.default)({
    transport: {
        target: 'pino-pretty',
    },
});
async function main() {
    logger.info('Initialisation du Sniper Bot Solana...');
    const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    const wsUrl = process.env.WS_URL || 'wss://api.mainnet-beta.solana.com';
    const connection = new web3_js_1.Connection(rpcUrl, {
        wsEndpoint: wsUrl,
        commitment: 'confirmed',
    });
    if (!process.env.PRIVATE_KEY) {
        logger.error('Erreur : PRIVATE_KEY manquante dans le fichier .env');
        process.exit(1);
    }
    const wallet = web3_js_1.Keypair.fromSecretKey(bs58_1.default.decode(process.env.PRIVATE_KEY));
    logger.info(`Wallet chargé : ${wallet.publicKey.toString()}`);
    const monitor = new monitor_1.PoolMonitor(connection);
    const executor = new executor_1.SwapExecutor(connection, wallet);
    const buyAmount = parseFloat(process.env.BUY_AMOUNT || '0.1');
    const slippage = parseInt(process.env.SLIPPAGE || '15') * 100; // Conversion en BPS
    await monitor.start(async (tokenMint, poolId) => {
        logger.info(`Traitement du nouveau token : ${tokenMint}`);
        // Ici, on pourrait ajouter des filtres de sécurité (LP Burned, etc.)
        // Pour cet exemple, on procède directement à l'achat
        const txid = await executor.buyToken(tokenMint, buyAmount, slippage);
        if (txid) {
            logger.info('Achat terminé avec succès.');
            // On pourrait ajouter ici une logique de vente automatique (Take Profit / Stop Loss)
        }
    });
}
main().catch(err => {
    logger.error(`Erreur fatale : ${err}`);
});
//# sourceMappingURL=index.js.map