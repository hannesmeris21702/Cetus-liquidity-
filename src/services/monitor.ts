import { CetusSDKService } from './sdk';
import { BotConfig } from '../config';
import { logger } from '../utils/logger';
import BN from 'bn.js';

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

  async getPoolInfo(poolAddress: string): Promise<PoolInfo> {
    try {
      logger.debug(`Fetching pool info for: ${poolAddress}`);
      const sdk = this.sdkService.getSdk();
      const pool = await sdk.Pool.getPool(poolAddress);

      if (!pool) {
        throw new Error(`Pool not found: ${poolAddress}. Please verify the pool address exists on ${this.config.network}.`);
      }

      logger.debug('Pool info retrieved successfully', {
        poolAddress,
        currentTick: pool.current_tick_index,
        coinTypeA: pool.coinTypeA,
        coinTypeB: pool.coinTypeB,
      });

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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Provide helpful error messages
      if (errorMessage.includes('Pool not found')) {
        logger.error(`Pool ${poolAddress} does not exist on ${this.config.network}. Please check:
  1. The pool address is correct
  2. You're connected to the right network (mainnet/testnet)
  3. The pool exists on Cetus: https://app.cetus.zone/`);
      } else if (errorMessage.includes('network') || errorMessage.includes('fetch') || errorMessage.includes('ECONNREFUSED')) {
        logger.error(`Network error while fetching pool info. Please check:
  1. Your internet connection
  2. The RPC endpoint is accessible: ${this.config.suiRpcUrl || 'default'}
  3. Try setting a custom SUI_RPC_URL in .env if using default`);
      } else {
        logger.error('Failed to get pool info', {
          poolAddress,
          network: this.config.network,
          error: errorMessage,
        });
      }
      
      throw error;
    }
  }

  async getPositions(ownerAddress: string): Promise<PositionInfo[]> {
    try {
      const sdk = this.sdkService.getSdk();
      const positions = await sdk.Position.getPositionList(ownerAddress);

      return positions.map((pos: any) => ({
        positionId: pos.pos_object_id,
        poolAddress: pos.pool,
        tickLower: pos.tick_lower_index,
        tickUpper: pos.tick_upper_index,
        liquidity: pos.liquidity,
        tokenA: pos.coin_type_a,
        tokenB: pos.coin_type_b,
        inRange: this.isPositionInRange(
          pos.tick_lower_index,
          pos.tick_upper_index,
          pos.current_tick_index
        ),
      }));
    } catch (error) {
      logger.error('Failed to get positions', error);
      throw error;
    }
  }

  isPositionInRange(tickLower: number, tickUpper: number, currentTick: number): boolean {
    return currentTick >= tickLower && currentTick <= tickUpper;
  }

  shouldRebalance(position: PositionInfo, poolInfo: PoolInfo): boolean {
    const currentTick = poolInfo.currentTickIndex;
    const { tickLower, tickUpper } = position;

    // Check if position is out of range
    if (!position.inRange) {
      logger.info('Position is out of range - rebalance needed');
      return true;
    }

    // Calculate distance to boundaries as percentage
    const rangeWidth = tickUpper - tickLower;
    const distanceToLower = currentTick - tickLower;
    const distanceToUpper = tickUpper - currentTick;

    const percentageToLower = distanceToLower / rangeWidth;
    const percentageToUpper = distanceToUpper / rangeWidth;

    // Check if we're too close to boundaries (within threshold)
    const threshold = this.config.rebalanceThreshold;
    
    if (percentageToLower < threshold || percentageToUpper < threshold) {
      logger.info(`Position approaching range boundary - rebalance recommended`, {
        percentageToLower,
        percentageToUpper,
        threshold,
      });
      return true;
    }

    return false;
  }

  calculateOptimalRange(currentTick: number, tickSpacing: number): { lower: number; upper: number } {
    // If range width is specified, use it
    const rangeWidth = this.config.rangeWidth || tickSpacing * 10;
    
    // Center the range around current tick
    const ticksBelow = Math.floor(rangeWidth / 2);
    const ticksAbove = Math.ceil(rangeWidth / 2);

    // Align to tick spacing
    const lower = Math.floor((currentTick - ticksBelow) / tickSpacing) * tickSpacing;
    const upper = Math.ceil((currentTick + ticksAbove) / tickSpacing) * tickSpacing;

    return { lower, upper };
  }

  async monitorPosition(poolAddress: string): Promise<{
    pool: PoolInfo;
    positions: PositionInfo[];
    needsRebalance: boolean;
  }> {
    try {
      logger.debug('Monitoring position for pool', { poolAddress });

      const pool = await this.getPoolInfo(poolAddress);
      const ownerAddress = this.sdkService.getAddress();
      const positions = await this.getPositions(ownerAddress);

      // Filter positions for this pool
      const poolPositions = positions.filter(p => p.poolAddress === poolAddress);

      // Check if any position needs rebalancing
      const needsRebalance = poolPositions.some(pos => this.shouldRebalance(pos, pool));

      logger.info('Position monitoring completed', {
        poolAddress,
        currentTick: pool.currentTickIndex,
        positionsCount: poolPositions.length,
        needsRebalance,
      });

      return {
        pool,
        positions: poolPositions,
        needsRebalance,
      };
    } catch (error) {
      logger.error('Failed to monitor position', error);
      throw error;
    }
  }
}
