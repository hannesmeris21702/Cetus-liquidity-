import { CetusSDKService } from './sdk';
import { PositionMonitorService, PoolInfo } from './monitor';
import { BotConfig } from '../config';
import { logger } from '../utils/logger';
import BN from 'bn.js';

export interface RebalanceResult {
  success: boolean;
  transactionDigest?: string;
  error?: string;
  oldPosition?: {
    tickLower: number;
    tickUpper: number;
  };
  newPosition?: {
    tickLower: number;
    tickUpper: number;
  };
}

export class RebalanceService {
  private sdkService: CetusSDKService;
  private monitorService: PositionMonitorService;
  private config: BotConfig;

  constructor(
    sdkService: CetusSDKService,
    monitorService: PositionMonitorService,
    config: BotConfig
  ) {
    this.sdkService = sdkService;
    this.monitorService = monitorService;
    this.config = config;
  }

  async rebalancePosition(poolAddress: string): Promise<RebalanceResult> {
    try {
      logger.info('Starting rebalance process', { poolAddress });

      // Get current pool state
      const poolInfo = await this.monitorService.getPoolInfo(poolAddress);
      const ownerAddress = this.sdkService.getAddress();
      const positions = await this.monitorService.getPositions(ownerAddress);
      const poolPositions = positions.filter(p => p.poolAddress === poolAddress);

      if (poolPositions.length === 0) {
        logger.info('No positions found for pool - creating new position');
        return await this.createNewPosition(poolInfo);
      }

      // For simplicity, rebalance the first position
      const position = poolPositions[0];
      logger.info('Rebalancing existing position', {
        positionId: position.positionId,
        currentTick: poolInfo.currentTickIndex,
        oldRange: { lower: position.tickLower, upper: position.tickUpper },
      });

      // Calculate optimal range
      const { lower, upper } = this.monitorService.calculateOptimalRange(
        poolInfo.currentTickIndex,
        poolInfo.tickSpacing
      );

      // If range hasn't changed significantly, skip rebalance
      if (
        Math.abs(position.tickLower - lower) < poolInfo.tickSpacing &&
        Math.abs(position.tickUpper - upper) < poolInfo.tickSpacing
      ) {
        logger.info('Range unchanged - skipping rebalance');
        return {
          success: true,
          oldPosition: { tickLower: position.tickLower, tickUpper: position.tickUpper },
          newPosition: { tickLower: lower, tickUpper: upper },
        };
      }

      // Remove liquidity from old position
      await this.removeLiquidity(position.positionId, position.liquidity);

      // Create new position with new range
      const result = await this.addLiquidity(poolInfo, lower, upper);

      logger.info('Rebalance completed successfully', {
        oldRange: { lower: position.tickLower, upper: position.tickUpper },
        newRange: { lower, upper },
        transactionDigest: result.transactionDigest,
      });

      return {
        success: true,
        transactionDigest: result.transactionDigest,
        oldPosition: { tickLower: position.tickLower, tickUpper: position.tickUpper },
        newPosition: { tickLower: lower, tickUpper: upper },
      };
    } catch (error) {
      logger.error('Rebalance failed', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async createNewPosition(poolInfo: PoolInfo): Promise<RebalanceResult> {
    try {
      const { lower, upper } = this.config.lowerTick && this.config.upperTick
        ? { lower: this.config.lowerTick, upper: this.config.upperTick }
        : this.monitorService.calculateOptimalRange(
            poolInfo.currentTickIndex,
            poolInfo.tickSpacing
          );

      logger.info('Creating new position', { lower, upper });

      const result = await this.addLiquidity(poolInfo, lower, upper);

      return {
        success: true,
        transactionDigest: result.transactionDigest,
        newPosition: { tickLower: lower, tickUpper: upper },
      };
    } catch (error) {
      logger.error('Failed to create new position', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async removeLiquidity(positionId: string, liquidity: string): Promise<void> {
    try {
      logger.info('Removing liquidity', { positionId, liquidity });

      const sdk = this.sdkService.getSdk();

      // Build remove liquidity transaction
      // Note: This is simplified - actual implementation depends on SDK API and configuration
      // The SDK method signature may vary based on version
      logger.info('Building remove liquidity transaction');
      
      // Example (commented out - needs proper SDK setup):
      // const removeLiquidityPayload = await sdk.Position.removeLiquidityTransactionPayload({
      //   pos_id: positionId,
      //   delta_liquidity: liquidity,
      //   min_amount_a: '0',
      //   min_amount_b: '0',
      //   coinTypeA: poolInfo.coinTypeA,
      //   coinTypeB: poolInfo.coinTypeB,
      // });

      logger.warn('Remove liquidity requires full SDK implementation with contract addresses');
    } catch (error) {
      logger.error('Failed to remove liquidity', error);
      throw error;
    }
  }

  private async addLiquidity(
    poolInfo: PoolInfo,
    tickLower: number,
    tickUpper: number
  ): Promise<{ transactionDigest?: string }> {
    try {
      logger.info('Adding liquidity', {
        poolAddress: poolInfo.poolAddress,
        tickLower,
        tickUpper,
      });

      const sdk = this.sdkService.getSdk();

      // Note: This is a simplified version
      // In production, you would need to:
      // 1. Calculate proper token amounts based on current price
      // 2. Handle coin selection and merging
      // 3. Execute the actual transaction with proper gas budget
      // 4. Handle errors and retries

      logger.warn('Add liquidity is a placeholder - implement based on your specific needs');

      return {
        transactionDigest: undefined,
      };
    } catch (error) {
      logger.error('Failed to add liquidity', error);
      throw error;
    }
  }

  async checkAndRebalance(poolAddress: string): Promise<RebalanceResult | null> {
    try {
      const monitorResult = await this.monitorService.monitorPosition(poolAddress);

      if (!monitorResult.needsRebalance) {
        logger.info('Position is optimal - no rebalance needed');
        return null;
      }

      logger.info('Position needs rebalancing - executing rebalance');
      return await this.rebalancePosition(poolAddress);
    } catch (error) {
      logger.error('Check and rebalance failed', error);
      throw error;
    }
  }
}
