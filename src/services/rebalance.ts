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

interface AddLiquidityFixTokenParams {
  pool_id: string;
  pos_id: string;
  tick_lower: number;
  tick_upper: number;
  amount_a: string;
  amount_b: string;
  slippage: number;
  fix_amount_a: boolean;
  is_open: boolean;
  coinTypeA: string;
  coinTypeB: string;
  collect_fee: boolean;
  rewarder_coin_types: string[];
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

      // Find positions that actually need rebalancing
      const positionsNeedingRebalance = poolPositions.filter(p => 
        this.monitorService.shouldRebalance(p, poolInfo)
      );

      if (positionsNeedingRebalance.length === 0) {
        logger.info('No position currently needs rebalancing');
        return { success: true };
      }

      // Check if any position needing rebalance has liquidity to move
      const hasLiquidityToMove = positionsNeedingRebalance.some(p => 
        p.liquidity != null && BigInt(p.liquidity) > 0n
      );

      if (!hasLiquidityToMove) {
        // All out-of-range positions are empty - check if in-range position already exists
        const inRangePositions = poolPositions.filter(p => 
          !this.monitorService.shouldRebalance(p, poolInfo)
        );
        
        if (inRangePositions.length > 0) {
          logger.info('Out-of-range positions have no liquidity and in-range position already exists - no action needed');
          return { success: true };
        }
        
        logger.info('No in-range position exists - will create new position with wallet funds');
      }

      // Prefer positions with liquidity for rebalancing
      positionsNeedingRebalance.sort((a, b) => {
        const liqA = BigInt(a.liquidity || '0');
        const liqB = BigInt(b.liquidity || '0');
        if (liqA > liqB) return -1;
        if (liqA < liqB) return 1;
        return 0;
      });

      const position = positionsNeedingRebalance[0];
      logger.info('Rebalancing existing position', {
        positionId: position.positionId,
        currentTick: poolInfo.currentTickIndex,
        oldRange: { lower: position.tickLower, upper: position.tickUpper },
        liquidity: position.liquidity,
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

      // Check if position has liquidity before trying to remove
      // Explicitly handle null/undefined and check for non-zero liquidity
      const hasLiquidity = position.liquidity != null && BigInt(position.liquidity) > 0n;
      
      // Track token amounts freed by removing liquidity so we can re-add the same amount
      let removedAmountA: string | undefined;
      let removedAmountB: string | undefined;

      if (hasLiquidity) {
        // Try to remove liquidity from old position
        try {
          // Capture wallet balances before removal
          const suiClient = this.sdkService.getSuiClient();
          const ownerAddress = this.sdkService.getAddress();
          const balanceBeforeA = await suiClient.getBalance({
            owner: ownerAddress,
            coinType: poolInfo.coinTypeA,
          });
          const balanceBeforeB = await suiClient.getBalance({
            owner: ownerAddress,
            coinType: poolInfo.coinTypeB,
          });

          await this.removeLiquidity(position.positionId, position.liquidity);

          // Capture wallet balances after removal to determine freed amounts
          const balanceAfterA = await suiClient.getBalance({
            owner: ownerAddress,
            coinType: poolInfo.coinTypeA,
          });
          const balanceAfterB = await suiClient.getBalance({
            owner: ownerAddress,
            coinType: poolInfo.coinTypeB,
          });

          // Compute freed token amounts from wallet balance delta.
          // Note: This approach assumes no concurrent transactions modify the wallet
          // during the removal. For a single-wallet bot this is reliable. The Cetus SDK
          // remove liquidity transaction does not directly expose returned token amounts.
          const deltaA = BigInt(balanceAfterA.totalBalance) - BigInt(balanceBeforeA.totalBalance);
          const deltaB = BigInt(balanceAfterB.totalBalance) - BigInt(balanceBeforeB.totalBalance);
          // An out-of-range position may have all value in one token, so one delta may be 0
          removedAmountA = deltaA > 0n ? deltaA.toString() : undefined;
          removedAmountB = deltaB > 0n ? deltaB.toString() : undefined;

          logger.info('Token amounts freed from removed position', {
            removedAmountA: removedAmountA || '0',
            removedAmountB: removedAmountB || '0',
          });
        } catch (removeError) {
          logger.error('Failed to remove liquidity from old position', removeError);
          // Log the error but continue to try adding liquidity to new position
          // This handles the case where position already has no liquidity
          logger.info('Continuing with adding liquidity to new position despite removal failure');
        }
      } else {
        logger.info('Position has no liquidity - skipping removal step');
      }

      // Check if an existing position already covers the optimal range
      const existingInRangePosition = poolPositions.find(p =>
        p.positionId !== position.positionId &&
        p.tickLower === lower &&
        p.tickUpper === upper
      );

      if (existingInRangePosition) {
        logger.info('Found existing position at optimal range - adding liquidity to it', {
          positionId: existingInRangePosition.positionId,
        });
      }

      // Add liquidity to existing in-range position or create a new one
      // Pass the removed token amounts so the same liquidity is re-added
      const result = await this.addLiquidity(poolInfo, lower, upper, existingInRangePosition?.positionId, removedAmountA, removedAmountB);

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
      const ownerAddress = this.sdkService.getAddress();

      // Execute remove liquidity with retry logic
      logger.info('Executing remove liquidity transaction');
      const result = await this.retryTransaction(
        async () => {
          // Refetch position details on each retry to get latest state
          const positions = await this.monitorService.getPositions(ownerAddress);
          const position = positions.find(p => p.positionId === positionId);

          if (!position) {
            throw new Error(`Position ${positionId} not found`);
          }

          // Build remove liquidity transaction payload with fresh position data
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

          const removeLiquidityPayload = await sdk.Position.removeLiquidityTransactionPayload(params as any);
          
          const txResult = await suiClient.signAndExecuteTransaction({
            transaction: removeLiquidityPayload,
            signer: keypair,
            options: {
              showEffects: true,
              showEvents: true,
            },
          });

          if (txResult.effects?.status?.status !== 'success') {
            throw new Error(`Transaction failed: ${txResult.effects?.status?.error || 'Unknown error'}`);
          }

          return txResult;
        },
        'remove liquidity',
        3,
        2000
      );

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

  /**
   * Helper function to retry a transaction with exponential backoff.
   * Handles stale object references and pending transactions.
   */
  private async retryTransaction<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = 3,
    initialDelayMs: number = 2000
  ): Promise<T> {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = initialDelayMs * Math.pow(2, attempt - 1);
          logger.info(`Retry attempt ${attempt + 1}/${maxRetries} for ${operationName} after ${delay}ms delay`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        return await operation();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        lastError = error instanceof Error ? error : new Error(errorMsg);
        
        // Check if this is a retryable error
        // Stale object errors: Object version mismatch
        const isStaleObject = errorMsg.includes('is not available for consumption') || 
                             (errorMsg.includes('Version') && errorMsg.includes('Digest')) ||
                             errorMsg.includes('current version:');
        
        // Pending transaction errors: Transaction still in progress
        const isPendingTx = (errorMsg.includes('pending') && errorMsg.includes('seconds old')) || 
                           (errorMsg.includes('pending') && errorMsg.includes('above threshold'));
        
        if (!isStaleObject && !isPendingTx) {
          // Non-retryable error, throw immediately
          logger.error(`Non-retryable error in ${operationName}: ${errorMsg}`);
          throw error;
        }
        
        if (attempt < maxRetries - 1) {
          logger.warn(`Retryable error in ${operationName} (attempt ${attempt + 1}/${maxRetries}): ${errorMsg}`);
        } else {
          logger.error(`Max retries (${maxRetries}) exceeded for ${operationName}`);
        }
      }
    }
    
    // Should never reach here unless all retries failed
    throw lastError || new Error(`All retry attempts failed for ${operationName} with unknown error`);
  }

  private async addLiquidity(
    poolInfo: PoolInfo,
    tickLower: number,
    tickUpper: number,
    existingPositionId?: string,
    removedAmountA?: string,
    removedAmountB?: string
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

      // Use removed amounts (from rebalance) if available, otherwise fall back to
      // configured amounts or a portion of available balance
      // Use BigInt arithmetic to avoid precision loss with large numbers
      const balanceABigInt = BigInt(balanceA.totalBalance);
      const balanceBBigInt = BigInt(balanceB.totalBalance);
      const defaultMinAmount = 1000n;
      
      let amountA: string;
      let amountB: string;
      
      if (removedAmountA || removedAmountB) {
        // Rebalancing: use the same token amounts that were freed from the old position
        amountA = removedAmountA || '0';
        amountB = removedAmountB || '0';
        logger.info('Using removed position amounts for rebalance', { amountA, amountB });
      } else {
        amountA = this.config.tokenAAmount || String(balanceABigInt > 0n ? balanceABigInt / 10n : defaultMinAmount);
        amountB = this.config.tokenBAmount || String(balanceBBigInt > 0n ? balanceBBigInt / 10n : defaultMinAmount);
      }

      // Validate amounts
      try {
        const amountABigInt = BigInt(amountA);
        const amountBBigInt = BigInt(amountB);
        
        if (removedAmountA || removedAmountB) {
          // During rebalance, an out-of-range position may have all value in one token
          if (amountABigInt === 0n && amountBBigInt === 0n) {
            throw new Error('No tokens were freed from the removed position.');
          }
        } else {
          if (amountABigInt === 0n || amountBBigInt === 0n) {
            throw new Error('Insufficient token balance to add liquidity. Please ensure you have both tokens in your wallet.');
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('Cannot convert')) {
          throw new Error('Invalid token amount configuration');
        }
        throw error;
      }

      // Determine which token to fix based on available amounts.
      // When one amount is 0 (common for out-of-range positions), this ensures
      // we fix the non-zero token so the SDK can compute the required counterpart.
      const fixAmountA = BigInt(amountA) >= BigInt(amountB);

      let positionId: string;
      let openPositionDigest: string | undefined;

      if (existingPositionId) {
        // Use existing position instead of creating a new one
        positionId = existingPositionId;
        logger.info('Adding liquidity to existing position', {
          positionId,
          amountA,
          amountB,
          tickLower,
          tickUpper,
        });
      } else {
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
        
        // First, open the position with retry logic
        logger.info('Opening position...');
        const openResult = await this.retryTransaction(
          async () => {
            const openPositionPayload = await sdk.Position.openPositionTransactionPayload(openParams as any);
            
            const result = await suiClient.signAndExecuteTransaction({
              transaction: openPositionPayload,
              signer: keypair,
              options: {
                showEffects: true,
                showEvents: true,
                showObjectChanges: true,
              },
            });

            if (result.effects?.status?.status !== 'success') {
              throw new Error(`Failed to open position: ${result.effects?.status?.error || 'Unknown error'}`);
            }

            return result;
          },
          'open position',
          3,
          2000
        );

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
        positionId = positionObject.objectId as string;
        openPositionDigest = openResult.digest;
        logger.info('Position NFT created', { positionId });
      }

      // Now add liquidity to the position
      try {
        logger.info('Adding liquidity to position...');
        
        // Use the SDK's fix token method which automatically calculates liquidity
        // Fix the token with the larger amount to maximize liquidity added
        const addLiquidityParams: AddLiquidityFixTokenParams = {
          pool_id: poolInfo.poolAddress,
          pos_id: positionId,
          tick_lower: tickLower,
          tick_upper: tickUpper,
          amount_a: amountA,
          amount_b: amountB,
          slippage: this.config.maxSlippage,
          fix_amount_a: fixAmountA,
          is_open: false, // Position is already open
          coinTypeA: poolInfo.coinTypeA,
          coinTypeB: poolInfo.coinTypeB,
          collect_fee: false,
          rewarder_coin_types: [],
        };
        
        // Add liquidity with retry logic
        logger.info('Executing add liquidity transaction...');
        const addResult = await this.retryTransaction(
          async () => {
            // Refetch pool state on each retry to get latest version
            const pool = await sdk.Pool.getPool(poolInfo.poolAddress);
            const currentSqrtPrice = new BN(pool.current_sqrt_price);
            
            // Use createAddLiquidityFixTokenPayload which handles liquidity calculation
            const addLiquidityPayload = await sdk.Position.createAddLiquidityFixTokenPayload(
              addLiquidityParams as any,
              {
                slippage: this.config.maxSlippage,
                curSqrtPrice: currentSqrtPrice,
              }
            );
            
            const result = await suiClient.signAndExecuteTransaction({
              transaction: addLiquidityPayload,
              signer: keypair,
              options: {
                showEffects: true,
                showEvents: true,
              },
            });
            
            if (result.effects?.status?.status !== 'success') {
              throw new Error(`Failed to add liquidity: ${result.effects?.status?.error || 'Unknown error'}`);
            }
            
            return result;
          },
          'add liquidity',
          3,
          2000
        );
        
        logger.info('Liquidity added successfully', {
          digest: addResult.digest,
          positionId,
          amountA,
          amountB,
        });
        
        return {
          transactionDigest: addResult.digest,
        };
      } catch (addError) {
        logger.error('Failed to add liquidity to position', addError);
        logger.warn('Position is open but has no liquidity. You may need to add liquidity manually.');
        return {
          transactionDigest: openPositionDigest,
        };
      }
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
