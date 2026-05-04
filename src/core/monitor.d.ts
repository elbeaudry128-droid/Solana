import { Connection } from '@solana/web3.js';
export declare class PoolMonitor {
    private connection;
    constructor(connection: Connection);
    start(callback: (tokenMint: string, poolId: string) => void): Promise<void>;
    private processNewPool;
}
//# sourceMappingURL=monitor.d.ts.map