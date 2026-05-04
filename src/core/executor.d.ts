import { Connection, Keypair } from '@solana/web3.js';
export declare class SwapExecutor {
    private connection;
    private wallet;
    constructor(connection: Connection, wallet: Keypair);
    buyToken(tokenMint: string, amountInSol: number, slippageBps?: number): Promise<string | null>;
}
//# sourceMappingURL=executor.d.ts.map