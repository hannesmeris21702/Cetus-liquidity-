import { CetusSDKService } from './sdk';
import { BotConfig } from '../config';
import { logger } from '../utils/logger';
import { retryWithBackoff } from '../utils/retry';

export interface PositionInfo {
  positionId: string;
  poolAddress: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  tokenA: string;
  tokenB: string;
  inRange: boolean;
}

export interface PoolInfo {
  poolAddress: string;
  currentTickIndex: number;
  currentSqrtPrice: string;
  coinTypeA: string;
  coinTypeB: string;
  tickSpacing: number;
}

export class PositionMonitorService {
  private sdkService: CetusSDKService;
  private config: BotConfig;

  constructor(sdkService: CetusSDKService, config: BotConfig) {
    this.sdkService = sdkService;
    this.config = config;
  }

  /** Fetch current pool state (tick index, sqrt price, coin types). */
  async getPoolInfo(poolAddress: string): Promise<PoolInfo> {
    const sdk = this.sdkService.getSdk();

    const pool = await retryWithBackoff(
      () => sdk.Pool.getPool(poolAddress),
      'getPoolInfo',
    );

    if (!pool) {
      throw new Error(`Pool not found: ${poolAddress}`);
    }

    return {
      poolAddress,
      currentTickIndex: typeof pool.current_tick_index === 'number'
        ? pool.current_tick_index
        : parseInt(pool.current_tick_index || '0'),
      currentSqrtPrice: String(pool.current_sqrt_price || '0'),
      coinTypeA: pool.coinTypeA || '',
      coinTypeB: pool.coinTypeB || '',
      tickSpacing: typeof pool.tickSpacing === 'number'
        ? pool.tickSpacing
        : parseInt(pool.tickSpacing || '1'),
    };
  }

  /** Fetch all positions owned by address. */
  async getPositions(ownerAddress: string): Promise<PositionInfo[]> {
    const sdk = this.sdkService.getSdk();
    const positions = await sdk.Position.getPositionList(ownerAddress);

    return positions.map((pos: any) => ({
      positionId: pos.pos_object_id,
      poolAddress: pos.pool,
      tickLower: pos.tick_lower_index,
      tickUpper: pos.tick_upper_index,
      liquidity: pos.liquidity,
      tokenA: pos.coin_type_a.startsWith('0x') ? pos.coin_type_a : `0x${pos.coin_type_a}`,
      tokenB: pos.coin_type_b.startsWith('0x') ? pos.coin_type_b : `0x${pos.coin_type_b}`,
      inRange: this.isPositionInRange(
        pos.tick_lower_index,
        pos.tick_upper_index,
        pos.current_tick_index,
      ),
    }));
  }

  /** True when currentTick is inside [tickLower, tickUpper]. */
  isPositionInRange(tickLower: number, tickUpper: number, currentTick: number): boolean {
    return currentTick >= tickLower && currentTick <= tickUpper;
  }
}
