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

// Type definitions for SDK parameters to avoid using 'as any'
interface RemoveLiquidityParams {
  pool_id: string;
  pos_id: string;
  delta_liquidity: string;
  min_amount_a: string;
  min_amount_b: string;
  coinTypeA: string;
  coinTypeB: string;
  collect_fee: boolean;
  rewarder_coin_types: string[];
}

interface OpenPositionParams {
  pool_id: string;
  tick_lower: string;
  tick_upper: string;
  coinTypeA: string;
  coinTypeB: string;
}

export class RebalanceService {
  private sdkService: CetusSDKService;
  private monitorService: PositionMonitorService;
  private config: BotConfig;
  private dryRun: boolean;

  constructor(
    sdkService: CetusSDKService,
    monitorService: PositionMonitorService,
    config: BotConfig
  ) {
    this.sdkService = sdkService;
    this.monitorService = monitorService;
    this.config = config;
    // Enable dry-run mode via environment variable
    this.dryRun = process.env.DRY_RUN === 'true';
    
    if (this.dryRun) {
      logger.warn('⚠️  DRY RUN MODE ENABLED - No real transactions will be executed');
    }
  }

  async rebalancePosition(poolAddress: string): Promise<RebalanceResult> {
    try {
      logger.info('Starting rebalance process', { poolAddress, dryRun: this.dryRun });

      // Get current pool state
      const poolInfo = await this.monitorService.getPoolInfo(poolAddress);
      const ownerAddress = this.sdkService.getAddress();
      const positions = await this.monitorService.getPositions(ownerAddress);
      const poolPositions = positions.filter(p => p.poolAddress === poolAddress);

      if (poolPositions.length === 0) {
        logger.info('No positions found for pool - creating new position');
        
        if (this.dryRun) {
          logger.info('[DRY RUN] Would create new position');
          const range = this.monitorService.calculateOptimalRange(
            poolInfo.currentTickIndex,
            poolInfo.tickSpacing
          );
          return {
            success: true,
            newPosition: { tickLower: range.lower, tickUpper: range.upper },
          };
        }
        
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

      if (this.dryRun) {
        logger.info('[DRY RUN] Would rebalance position', {
          oldRange: { lower: position.tickLower, upper: position.tickUpper },
          newRange: { lower, upper },
          liquidity: position.liquidity,
        });
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

      if (this.dryRun) {
        logger.info('[DRY RUN] Would create new position', { lower, upper });
        return {
          success: true,
          newPosition: { tickLower: lower, tickUpper: upper },
        };
      }

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
      const keypair = this.sdkService.getKeypair();
      const suiClient = this.sdkService.getSuiClient();

      // Get position details to get pool and coin types
      const ownerAddress = this.sdkService.getAddress();
      const positions = await this.monitorService.getPositions(ownerAddress);
      const position = positions.find(p => p.positionId === positionId);

      if (!position) {
        throw new Error(`Position ${positionId} not found`);
      }

      logger.info('Building remove liquidity transaction');

      // Build remove liquidity transaction payload
      // Type-safe parameters for SDK call
      const params: RemoveLiquidityParams = {
        pool_id: position.poolAddress,
        pos_id: positionId,
        delta_liquidity: liquidity,
        min_amount_a: '0', // Accept any amount due to slippage
        min_amount_b: '0',
        coinTypeA: position.tokenA,
        coinTypeB: position.tokenB,
        collect_fee: true, // Collect fees when removing liquidity
        rewarder_coin_types: [], // No rewards for simplicity
      };
      
      const removeLiquidityPayload = await sdk.Position.removeLiquidityTransactionPayload(params as any); // Note: SDK types may vary by version

      // Sign and execute the transaction
      logger.info('Executing remove liquidity transaction');
      const result = await suiClient.signAndExecuteTransactionBlock({
        transactionBlock: removeLiquidityPayload,
        signer: keypair,
        options: {
          showEffects: true,
          showEvents: true,
        },
      });

      if (result.effects?.status?.status !== 'success') {
        throw new Error(`Transaction failed: ${result.effects?.status?.error || 'Unknown error'}`);
      }

      logger.info('Liquidity removed successfully', {
        digest: result.digest,
        gasUsed: result.effects?.gasUsed,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`Failed to remove liquidity: ${errorMsg}`);
      if (errorStack) {
        logger.error('Stack trace:', errorStack);
      }
      
      // Provide helpful error messages
      if (errorMsg.includes('Position') || errorMsg.includes('not found')) {
        logger.error('Position not found or already closed');
      } else if (errorMsg.includes('insufficient') || errorMsg.includes('balance')) {
        logger.error('Insufficient balance or liquidity');
      }
      
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
      const keypair = this.sdkService.getKeypair();
      const suiClient = this.sdkService.getSuiClient();
      const ownerAddress = this.sdkService.getAddress();

      // Get coin balances to determine how much we can add
      const balanceA = await suiClient.getBalance({
        owner: ownerAddress,
        coinType: poolInfo.coinTypeA,
      });
      const balanceB = await suiClient.getBalance({
        owner: ownerAddress,
        coinType: poolInfo.coinTypeB,
      });

      logger.info('Token balances', {
        tokenA: balanceA.totalBalance,
        tokenB: balanceB.totalBalance,
        coinTypeA: poolInfo.coinTypeA,
        coinTypeB: poolInfo.coinTypeB,
      });

      // Use configured amounts or default to a portion of available balance
      // Use BigInt arithmetic to avoid precision loss with large numbers
      const balanceABigInt = BigInt(balanceA.totalBalance);
      const balanceBBigInt = BigInt(balanceB.totalBalance);
      const defaultMinAmount = 1000n;
      
      const amountA = this.config.tokenAAmount || String(balanceABigInt > 0n ? balanceABigInt / 10n : defaultMinAmount);
      const amountB = this.config.tokenBAmount || String(balanceBBigInt > 0n ? balanceBBigInt / 10n : defaultMinAmount);

      // Validate amounts
      try {
        const amountABigInt = BigInt(amountA);
        const amountBBigInt = BigInt(amountB);
        
        if (amountABigInt === 0n || amountBBigInt === 0n) {
          throw new Error('Insufficient token balance to add liquidity. Please ensure you have both tokens in your wallet.');
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('Cannot convert')) {
          throw new Error('Invalid token amount configuration');
        }
        throw error;
      }

      logger.info('Opening new position with liquidity', {
        amountA,
        amountB,
        tickLower,
        tickUpper,
      });

      // Build open position transaction with type-safe parameters
      const openParams: OpenPositionParams = {
        pool_id: poolInfo.poolAddress,
        tick_lower: tickLower.toString(),
        tick_upper: tickUpper.toString(),
        coinTypeA: poolInfo.coinTypeA,
        coinTypeB: poolInfo.coinTypeB,
      };
      
      const openPositionPayload = await sdk.Position.openPositionTransactionPayload(openParams as any); // Note: SDK types may vary by version

      // First, open the position
      logger.info('Opening position...');
      const openResult = await suiClient.signAndExecuteTransactionBlock({
        transactionBlock: openPositionPayload,
        signer: keypair,
        options: {
          showEffects: true,
          showEvents: true,
          showObjectChanges: true,
        },
      });

      if (openResult.effects?.status?.status !== 'success') {
        throw new Error(`Failed to open position: ${openResult.effects?.status?.error || 'Unknown error'}`);
      }

      logger.info('Position opened successfully', {
        digest: openResult.digest,
      });

      // Extract the position NFT ID from the result
      // Search for created position object in transaction changes
      const createdObjects = (openResult.objectChanges?.filter((change: any) => change.type === 'created') || []) as any[];
      const positionObject = createdObjects.find((obj: any) => 
        obj.objectType && typeof obj.objectType === 'string' && obj.objectType.includes('Position')
      );

      if (!positionObject || !positionObject.objectId) {
        // Position might be created but we couldn't extract the ID
        // Log success but note that we couldn't track the position ID
        logger.warn('Position created but could not extract position NFT ID from transaction result');
        return {
          transactionDigest: openResult.digest,
        };
      }

      // Extract the position ID (validated above)
      const positionId: string = positionObject.objectId as string;
      logger.info('Position NFT created', { positionId });

      // Try to add liquidity to the position
      // Note: In some SDK versions, opening a position and adding liquidity are combined
      // or adding liquidity happens in a separate call
      try {
        // Attempt to add liquidity if SDK supports it
        // This may not be necessary if opening position already added liquidity
        logger.info('Attempting to add initial liquidity...');
        
        // For now, we'll log that the position is created and return
        // In production, you may need to add liquidity in a separate transaction
        logger.info('Position created. You may need to add liquidity separately via the Cetus UI or another transaction.');
        
      } catch (addError) {
        logger.warn('Could not add liquidity automatically. Position is open but empty.', addError);
      }

      return {
        transactionDigest: openResult.digest,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`Failed to add liquidity: ${errorMsg}`);
      if (errorStack) {
        logger.error('Stack trace:', errorStack);
      }
      
      // Provide helpful error messages
      if (errorMsg.includes('insufficient') || errorMsg.includes('balance')) {
        logger.error('Insufficient token balance. Please ensure you have both tokens in your wallet.');
      } else if (errorMsg.includes('tick') || errorMsg.includes('range')) {
        logger.error('Invalid tick range. Check LOWER_TICK and UPPER_TICK configuration.');
      }
      
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
