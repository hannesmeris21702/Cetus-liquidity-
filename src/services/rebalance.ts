import { CetusSDKService } from './sdk';
import { PositionMonitorService, PoolInfo, PositionInfo } from './monitor';
import { BotConfig } from '../config';
import { logger } from '../utils/logger';
import BN from 'bn.js';
import { 
  TickMath, 
  getCoinAFromLiquidity, 
  getCoinBFromLiquidity 
} from '@cetusprotocol/cetus-sui-clmm-sdk';

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

interface AddLiquidityFixTokenParams {
  pool_id: string;
  pos_id: string;
  tick_lower: string | number;
  tick_upper: string | number;
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
  private trackedPositionId: string | null;

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
    // Track the single position this bot manages.  Initialized from config
    // and updated automatically after each rebalance cycle.
    this.trackedPositionId = config.positionId || null;
    
    if (this.dryRun) {
      logger.warn('⚠️  DRY RUN MODE ENABLED - No real transactions will be executed');
    }
  }

  /**
   * Calculate the required token amounts for a given liquidity value in a specific tick range.
   * This ensures that when we recreate a position, we maintain the SAME liquidity amount.
   * 
   * @param liquidity - The target liquidity value to preserve (as string)
   * @param tickLower - Lower tick of the new position
   * @param tickUpper - Upper tick of the new position
   * @param currentSqrtPrice - Current sqrt price of the pool (as string)
   * @returns Object with amountA and amountB as strings
   */
  private calculateTokenAmountsFromLiquidity(
    liquidity: string,
    tickLower: number,
    tickUpper: number,
    currentSqrtPrice: string
  ): { amountA: string; amountB: string } {
    try {
      const liquidityBN = new BN(liquidity);
      const currentSqrtPriceBN = new BN(currentSqrtPrice);
      
      // Get sqrt prices for the tick boundaries
      const sqrtPriceLower = TickMath.tickIndexToSqrtPriceX64(tickLower);
      const sqrtPriceUpper = TickMath.tickIndexToSqrtPriceX64(tickUpper);
      
      let amountA: BN;
      let amountB: BN;
      
      // Calculate amounts based on where current price is relative to the range
      if (currentSqrtPriceBN.lte(sqrtPriceLower)) {
        // Current price below range - all liquidity in token A
        amountA = getCoinAFromLiquidity(liquidityBN, sqrtPriceLower, sqrtPriceUpper, false);
        amountB = new BN(0);
      } else if (currentSqrtPriceBN.gte(sqrtPriceUpper)) {
        // Current price above range - all liquidity in token B
        amountA = new BN(0);
        amountB = getCoinBFromLiquidity(liquidityBN, sqrtPriceLower, sqrtPriceUpper, false);
      } else {
        // Current price in range - liquidity in both tokens
        amountA = getCoinAFromLiquidity(liquidityBN, currentSqrtPriceBN, sqrtPriceUpper, false);
        amountB = getCoinBFromLiquidity(liquidityBN, sqrtPriceLower, currentSqrtPriceBN, false);
      }
      
      logger.info('Calculated token amounts from target liquidity', {
        targetLiquidity: liquidity,
        tickRange: `[${tickLower}, ${tickUpper}]`,
        amountA: amountA.toString(),
        amountB: amountB.toString(),
      });
      
      return {
        amountA: amountA.toString(),
        amountB: amountB.toString(),
      };
    } catch (error) {
      logger.error('Failed to calculate token amounts from liquidity', error);
      throw error;
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
        logger.info('No existing positions found for pool — nothing to rebalance');
        return { success: false, error: 'No existing position to rebalance' };
      }

      // Find positions that actually need rebalancing
      let positionsNeedingRebalance: PositionInfo[];
      if (this.trackedPositionId) {
        // Only consider the tracked position
        const trackedPosition = poolPositions.find(p => p.positionId === this.trackedPositionId);
        positionsNeedingRebalance = trackedPosition && this.monitorService.shouldRebalance(trackedPosition, poolInfo)
          ? [trackedPosition]
          : [];
      } else {
        positionsNeedingRebalance = poolPositions.filter(p =>
          this.monitorService.shouldRebalance(p, poolInfo)
        );
      }

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

      // Calculate the new optimal range.  When tracking a specific position,
      // preserve its original range width so the rebalanced position covers the
      // same tick span.  Otherwise default to the tightest active range.
      const preserveWidth = this.trackedPositionId
        ? position.tickUpper - position.tickLower
        : undefined;
      const { lower, upper } = this.monitorService.calculateOptimalRange(
        poolInfo.currentTickIndex,
        poolInfo.tickSpacing,
        preserveWidth,
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
      
      // Capture the token amounts when removing liquidity to preserve the total VALUE
      // This ensures we maintain the same dollar value when creating the new position
      let removedTokenAmounts: { amountA: string; amountB: string } | undefined;
      
      if (hasLiquidity) {
        // Get suiClient to check balances
        const suiClient = this.sdkService.getSuiClient();
        
        // Get balances before removing liquidity
        const balancesBefore = await Promise.all([
          suiClient.getBalance({
            owner: ownerAddress,
            coinType: poolInfo.coinTypeA,
          }),
          suiClient.getBalance({
            owner: ownerAddress,
            coinType: poolInfo.coinTypeB,
          }),
        ]);
        
        const balanceBeforeA = BigInt(balancesBefore[0].totalBalance);
        const balanceBeforeB = BigInt(balancesBefore[1].totalBalance);
        
        logger.info('Balances before removing liquidity', {
          tokenA: balanceBeforeA.toString(),
          tokenB: balanceBeforeB.toString(),
        });
        
        // Remove liquidity from old position
        await this.removeLiquidity(position.positionId, position.liquidity);
        
        // Get balances after removing liquidity
        const balancesAfter = await Promise.all([
          suiClient.getBalance({
            owner: ownerAddress,
            coinType: poolInfo.coinTypeA,
          }),
          suiClient.getBalance({
            owner: ownerAddress,
            coinType: poolInfo.coinTypeB,
          }),
        ]);
        
        const balanceAfterA = BigInt(balancesAfter[0].totalBalance);
        const balanceAfterB = BigInt(balancesAfter[1].totalBalance);
        
        // Calculate the actual amounts received from removing liquidity
        const removedAmountA = balanceAfterA - balanceBeforeA;
        const removedAmountB = balanceAfterB - balanceBeforeB;
        
        removedTokenAmounts = {
          amountA: removedAmountA.toString(),
          amountB: removedAmountB.toString(),
        };
        
        logger.info('Captured removed token amounts (preserving liquidity VALUE)', {
          positionId: position.positionId,
          tickRange: `[${position.tickLower}, ${position.tickUpper}]`,
          removedAmountA: removedTokenAmounts.amountA,
          removedAmountB: removedTokenAmounts.amountB,
        });
        
        logger.info('Successfully removed liquidity from old position');
        
        // Immediately check if we need to swap tokens to match the new position requirements
        // This ensures both tokens are available before attempting to add liquidity
        try {
          const sdk = this.sdkService.getSdk();
          const pool = await sdk.Pool.getPool(poolInfo.poolAddress);
          const currentTickIndex = pool.current_tick_index;
          
          // Determine what tokens the new position will need
          const priceIsBelowRange = currentTickIndex < lower;
          const priceIsAboveRange = currentTickIndex >= upper;
          const priceIsInRange = !priceIsBelowRange && !priceIsAboveRange;
          
          logger.info('Checking token requirements for new position', {
            currentTickIndex,
            newTickRange: `[${lower}, ${upper}]`,
            priceIsBelowRange,
            priceIsInRange,
            priceIsAboveRange,
          });
          
          const removedAmountABigInt = BigInt(removedTokenAmounts.amountA);
          const removedAmountBBigInt = BigInt(removedTokenAmounts.amountB);
          
          // Reserve gas when a token is SUI
          const SUI_GAS_RESERVE = BigInt(this.config.gasBudget);
          const SUI_TYPE = '0x2::sui::SUI';
          const SUI_TYPE_FULL = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
          const isSuiCoinType = (ct: string) => ct === SUI_TYPE || ct === SUI_TYPE_FULL;
          const isSuiA = isSuiCoinType(poolInfo.coinTypeA);
          const isSuiB = isSuiCoinType(poolInfo.coinTypeB);
          
          // Calculate safe balances after removing liquidity
          const safeBalanceA = isSuiA && balanceAfterA > SUI_GAS_RESERVE
            ? balanceAfterA - SUI_GAS_RESERVE
            : balanceAfterA;
          const safeBalanceB = isSuiB && balanceAfterB > SUI_GAS_RESERVE
            ? balanceAfterB - SUI_GAS_RESERVE
            : balanceAfterB;
          
          // Check if we need to swap based on position type
          if (priceIsBelowRange && removedAmountABigInt === 0n && removedAmountBBigInt > 0n) {
            // New position is out-of-range below: needs only token A, but we only have token B
            logger.info('Position requires token A, but only have token B after removing liquidity. Swapping B→A...');
            await this.performSwap(poolInfo, false, safeBalanceB.toString());
            
            // Update balances and removed amounts after swap
            const swappedBalances = await Promise.all([
              suiClient.getBalance({
                owner: ownerAddress,
                coinType: poolInfo.coinTypeA,
              }),
              suiClient.getBalance({
                owner: ownerAddress,
                coinType: poolInfo.coinTypeB,
              }),
            ]);
            
            const swappedBalanceA = BigInt(swappedBalances[0].totalBalance);
            const swappedBalanceB = BigInt(swappedBalances[1].totalBalance);
            
            removedTokenAmounts.amountA = (isSuiA && swappedBalanceA > SUI_GAS_RESERVE
              ? swappedBalanceA - SUI_GAS_RESERVE
              : swappedBalanceA).toString();
            removedTokenAmounts.amountB = (isSuiB && swappedBalanceB > SUI_GAS_RESERVE
              ? swappedBalanceB - SUI_GAS_RESERVE
              : swappedBalanceB).toString();
            
            logger.info('Swapped tokens for new position', {
              newAmountA: removedTokenAmounts.amountA,
              newAmountB: removedTokenAmounts.amountB,
            });
          } else if (priceIsAboveRange && removedAmountBBigInt === 0n && removedAmountABigInt > 0n) {
            // New position is out-of-range above: needs only token B, but we only have token A
            logger.info('Position requires token B, but only have token A after removing liquidity. Swapping A→B...');
            await this.performSwap(poolInfo, true, safeBalanceA.toString());
            
            // Update balances and removed amounts after swap
            const swappedBalances = await Promise.all([
              suiClient.getBalance({
                owner: ownerAddress,
                coinType: poolInfo.coinTypeA,
              }),
              suiClient.getBalance({
                owner: ownerAddress,
                coinType: poolInfo.coinTypeB,
              }),
            ]);
            
            const swappedBalanceA = BigInt(swappedBalances[0].totalBalance);
            const swappedBalanceB = BigInt(swappedBalances[1].totalBalance);
            
            removedTokenAmounts.amountA = (isSuiA && swappedBalanceA > SUI_GAS_RESERVE
              ? swappedBalanceA - SUI_GAS_RESERVE
              : swappedBalanceA).toString();
            removedTokenAmounts.amountB = (isSuiB && swappedBalanceB > SUI_GAS_RESERVE
              ? swappedBalanceB - SUI_GAS_RESERVE
              : swappedBalanceB).toString();
            
            logger.info('Swapped tokens for new position', {
              newAmountA: removedTokenAmounts.amountA,
              newAmountB: removedTokenAmounts.amountB,
            });
          } else if (priceIsInRange && (removedAmountABigInt === 0n || removedAmountBBigInt === 0n)) {
            // New position is in-range: needs both tokens, but we only have one
            if (removedAmountABigInt === 0n && removedAmountBBigInt > 0n) {
              // Have only token B, need to swap half to get token A
              logger.info('Position requires both tokens, but only have token B after removing liquidity. Swapping half B→A...');
              const swapAmountB = safeBalanceB / 2n;
              await this.performSwap(poolInfo, false, swapAmountB.toString());
              
              // Update balances and removed amounts after swap
              const swappedBalances = await Promise.all([
                suiClient.getBalance({
                  owner: ownerAddress,
                  coinType: poolInfo.coinTypeA,
                }),
                suiClient.getBalance({
                  owner: ownerAddress,
                  coinType: poolInfo.coinTypeB,
                }),
              ]);
              
              const swappedBalanceA = BigInt(swappedBalances[0].totalBalance);
              const swappedBalanceB = BigInt(swappedBalances[1].totalBalance);
              
              removedTokenAmounts.amountA = (isSuiA && swappedBalanceA > SUI_GAS_RESERVE
                ? swappedBalanceA - SUI_GAS_RESERVE
                : swappedBalanceA).toString();
              removedTokenAmounts.amountB = (isSuiB && swappedBalanceB > SUI_GAS_RESERVE
                ? swappedBalanceB - SUI_GAS_RESERVE
                : swappedBalanceB).toString();
              
              logger.info('Swapped tokens for new position', {
                newAmountA: removedTokenAmounts.amountA,
                newAmountB: removedTokenAmounts.amountB,
              });
            } else if (removedAmountBBigInt === 0n && removedAmountABigInt > 0n) {
              // Have only token A, need to swap half to get token B
              logger.info('Position requires both tokens, but only have token A after removing liquidity. Swapping half A→B...');
              const swapAmountA = safeBalanceA / 2n;
              await this.performSwap(poolInfo, true, swapAmountA.toString());
              
              // Update balances and removed amounts after swap
              const swappedBalances = await Promise.all([
                suiClient.getBalance({
                  owner: ownerAddress,
                  coinType: poolInfo.coinTypeA,
                }),
                suiClient.getBalance({
                  owner: ownerAddress,
                  coinType: poolInfo.coinTypeB,
                }),
              ]);
              
              const swappedBalanceA = BigInt(swappedBalances[0].totalBalance);
              const swappedBalanceB = BigInt(swappedBalances[1].totalBalance);
              
              removedTokenAmounts.amountA = (isSuiA && swappedBalanceA > SUI_GAS_RESERVE
                ? swappedBalanceA - SUI_GAS_RESERVE
                : swappedBalanceA).toString();
              removedTokenAmounts.amountB = (isSuiB && swappedBalanceB > SUI_GAS_RESERVE
                ? swappedBalanceB - SUI_GAS_RESERVE
                : swappedBalanceB).toString();
              
              logger.info('Swapped tokens for new position', {
                newAmountA: removedTokenAmounts.amountA,
                newAmountB: removedTokenAmounts.amountB,
              });
            }
          } else {
            // Token distribution is already suitable for the new position
            logger.info('Token distribution after removing liquidity is suitable for new position', {
              amountA: removedTokenAmounts.amountA,
              amountB: removedTokenAmounts.amountB,
            });
          }
        } catch (swapError) {
          logger.warn('Failed to swap tokens after removing liquidity. Will attempt swap during add liquidity.', swapError);
          // Don't throw - the addLiquidity method has its own swap logic as a fallback
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
      // Pass the removed token amounts to preserve the SAME liquidity VALUE
      const result = await this.addLiquidity(
        poolInfo, 
        lower, 
        upper, 
        existingInRangePosition?.positionId, 
        removedTokenAmounts
      );

      // If a new position was created, discover it and update tracking so
      // subsequent cycles manage the new position instead of the old one.
      if (!existingInRangePosition) {
        try {
          const updatedPositions = await this.monitorService.getPositions(ownerAddress);
          const newPos = updatedPositions.find(p =>
            p.poolAddress === poolAddress &&
            p.tickLower === lower &&
            p.tickUpper === upper &&
            p.positionId !== position.positionId
          );
          if (newPos) {
            this.trackedPositionId = newPos.positionId;
            logger.info('Now tracking newly created position', { positionId: newPos.positionId });
          }
        } catch (err) {
          logger.warn('Could not discover new position ID after rebalance', err);
        }
      }

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
          removeLiquidityPayload.setGasBudget(this.config.gasBudget);
          
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

  /**
   * Retry add liquidity transaction with fixed delay and retry on ANY error.
   * This ensures that transient failures don't prevent liquidity from being added.
   * 
   * @param operation - The add liquidity operation to execute
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   * @param delayMs - Fixed delay in milliseconds between retries (default: 3000)
   * @returns The result of the operation
   * @throws The original error if all retries fail
   */
  private async retryAddLiquidity<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delayMs: number = 3000
  ): Promise<T> {
    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();
        
        // Log success with attempt number
        if (attempt === 1) {
          logger.info('Add liquidity succeeded on attempt 1');
        } else {
          logger.info(`Add liquidity succeeded on attempt ${attempt}`);
        }
        
        return result;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        lastError = error instanceof Error ? error : new Error(errorMsg);
        
        if (attempt < maxRetries) {
          // Log retry attempt
          logger.warn(`Add liquidity attempt ${attempt} failed, retrying...`);
          logger.debug(`Error details: ${errorMsg}`);
          
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          // All retries exhausted
          logger.error(`Add liquidity failed after ${maxRetries} attempts`);
        }
      }
    }
    
    // Preserve and throw the original error
    throw lastError || new Error('Add liquidity failed with unknown error');
  }

  /**
   * Detect if an error message indicates insufficient balance.
   * Matches error patterns: "Insufficient balance", "expect <amount>", "amount is Insufficient"
   */
  private isInsufficientBalanceError(errorMsg: string): boolean {
    const insufficientPatterns = [
      /insufficient balance/i,
      /expect\s+\d+/i, // More specific: matches "expect <number>" pattern
      /amount is insufficient/i,
    ];
    
    return insufficientPatterns.some(pattern => pattern.test(errorMsg));
  }

  /**
   * Calculate swap amount with buffer for slippage.
   * Adds a 10% buffer to account for slippage and ensure sufficient tokens.
   */
  private calculateSwapAmountWithBuffer(missingAmount: bigint): bigint {
    const SWAP_BUFFER_PERCENTAGE = 110n; // 110% = 10% buffer
    return (missingAmount * SWAP_BUFFER_PERCENTAGE) / 100n;
  }

  /**
   * Attempt to recover from insufficient balance error by swapping tokens.
   * This method:
   * 1. Identifies which token is insufficient (A or B)
   * 2. Calculates the missing amount
   * 3. Swaps the opposite token to acquire the missing amount
   */
  private async attemptSwapRecovery(
    poolInfo: PoolInfo,
    errorMsg: string,
    requestedAmountA: string,
    requestedAmountB: string,
    ownerAddress: string,
    suiClient: any
  ): Promise<void> {
    try {
      logger.info('Analyzing insufficient balance error...', { error: errorMsg });
      
      // Fetch current balances
      const [balanceA, balanceB] = await Promise.all([
        suiClient.getBalance({
          owner: ownerAddress,
          coinType: poolInfo.coinTypeA,
        }),
        suiClient.getBalance({
          owner: ownerAddress,
          coinType: poolInfo.coinTypeB,
        }),
      ]);
      
      const currentBalanceA = BigInt(balanceA.totalBalance);
      const currentBalanceB = BigInt(balanceB.totalBalance);
      const requiredA = BigInt(requestedAmountA);
      const requiredB = BigInt(requestedAmountB);
      
      logger.info('Balance analysis:', {
        currentBalanceA: currentBalanceA.toString(),
        currentBalanceB: currentBalanceB.toString(),
        requiredA: requiredA.toString(),
        requiredB: requiredB.toString(),
      });
      
      // Determine which token is insufficient
      const isTokenAInsufficient = currentBalanceA < requiredA;
      const isTokenBInsufficient = currentBalanceB < requiredB;
      
      // If neither token appears insufficient, log and return
      if (!isTokenAInsufficient && !isTokenBInsufficient) {
        logger.warn('Could not identify insufficient token from error, skipping recovery');
        return;
      }
      
      // Perform swap to acquire the missing token
      if (isTokenAInsufficient) {
        const missingAmountA = requiredA - currentBalanceA;
        logger.info(`Insufficient balance detected for Token A`, {
          required: requiredA.toString(),
          current: currentBalanceA.toString(),
          missing: missingAmountA.toString(),
        });
        
        // Swap B -> A for the missing amount (with buffer for slippage)
        const swapAmount = this.calculateSwapAmountWithBuffer(missingAmountA);
        
        if (currentBalanceB >= swapAmount) {
          logger.info(`Swapping Token B → Token A`, { amount: swapAmount.toString() });
          await this.performSwap(poolInfo, false, swapAmount.toString());
          logger.info('Swap recovery completed for Token A');
        } else {
          throw new Error(`Insufficient Token B balance to swap for missing Token A. Need ${swapAmount.toString()}, have ${currentBalanceB.toString()}`);
        }
      } else if (isTokenBInsufficient) {
        const missingAmountB = requiredB - currentBalanceB;
        logger.info(`Insufficient balance detected for Token B`, {
          required: requiredB.toString(),
          current: currentBalanceB.toString(),
          missing: missingAmountB.toString(),
        });
        
        // Swap A -> B for the missing amount (with buffer for slippage)
        const swapAmount = this.calculateSwapAmountWithBuffer(missingAmountB);
        
        if (currentBalanceA >= swapAmount) {
          logger.info(`Swapping Token A → Token B`, { amount: swapAmount.toString() });
          await this.performSwap(poolInfo, true, swapAmount.toString());
          logger.info('Swap recovery completed for Token B');
        } else {
          throw new Error(`Insufficient Token A balance to swap for missing Token B. Need ${swapAmount.toString()}, have ${currentBalanceA.toString()}`);
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Swap recovery failed:', errMsg);
      throw error;
    }
  }

  /**
   * Swap tokens within the pool.  Used to convert a single-sided token balance
   * into both tokens so that liquidity can be added to an in-range position.
   */
  private async performSwap(
    poolInfo: PoolInfo,
    aToB: boolean,
    amount: string,
  ): Promise<void> {
    const sdk = this.sdkService.getSdk();
    const keypair = this.sdkService.getKeypair();
    const suiClient = this.sdkService.getSuiClient();

    logger.info('Executing swap', {
      direction: aToB ? 'A→B' : 'B→A',
      amount,
      pool: poolInfo.poolAddress,
    });

    // Compute a minimum output using preswap to protect against slippage.
    // If the estimate fails we fall back to accepting any output.
    let amountLimit = '0';
    try {
      const pool = await sdk.Pool.getPool(poolInfo.poolAddress);
      const [metaA, metaB] = await Promise.all([
        suiClient.getCoinMetadata({ coinType: poolInfo.coinTypeA }),
        suiClient.getCoinMetadata({ coinType: poolInfo.coinTypeB }),
      ]);
      const preswapResult = await sdk.Swap.preswap({
        pool,
        currentSqrtPrice: Number(pool.current_sqrt_price),
        decimalsA: metaA?.decimals ?? 9,
        decimalsB: metaB?.decimals ?? 9,
        a2b: aToB,
        byAmountIn: true,
        amount,
        coinTypeA: poolInfo.coinTypeA,
        coinTypeB: poolInfo.coinTypeB,
      });
      if (preswapResult && preswapResult.estimatedAmountOut) {
        const estimated = BigInt(preswapResult.estimatedAmountOut);
        const slippageBps = BigInt(Math.floor(this.config.maxSlippage * 10000));
        const minOutput = estimated - (estimated * slippageBps) / 10000n;
        amountLimit = (minOutput > 0n ? minOutput : 0n).toString();
        logger.info('Swap slippage limit calculated', {
          estimatedOut: estimated.toString(),
          amountLimit,
        });
      }
    } catch (e) {
      logger.debug('Could not estimate swap output - proceeding without slippage limit');
    }

    const swapPayload = await sdk.Swap.createSwapTransactionPayload({
      pool_id: poolInfo.poolAddress,
      a2b: aToB,
      by_amount_in: true,
      amount,
      amount_limit: amountLimit,
      coinTypeA: poolInfo.coinTypeA,
      coinTypeB: poolInfo.coinTypeB,
    });
    swapPayload.setGasBudget(this.config.gasBudget);

    const result = await suiClient.signAndExecuteTransaction({
      transaction: swapPayload,
      signer: keypair,
      options: { 
        showEffects: true,
      },
    });

    if (result.effects?.status?.status !== 'success') {
      throw new Error(
        `Swap failed: ${result.effects?.status?.error || 'Unknown error'}`,
      );
    }

    logger.info('Swap completed', { digest: result.digest });
  }

  private async addLiquidity(
    poolInfo: PoolInfo,
    tickLower: number,
    tickUpper: number,
    existingPositionId?: string,
    preservedAmounts?: { amountA: string; amountB: string }
  ): Promise<{ transactionDigest?: string }> {
    try {
      logger.info('Adding liquidity', {
        poolAddress: poolInfo.poolAddress,
        tickLower,
        tickUpper,
        preservedAmounts: preservedAmounts || 'not specified',
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

      // Reserve gas when a token is SUI so the add-liquidity transaction
      // does not try to spend the entire balance and fail with balance::split.
      const SUI_GAS_RESERVE = BigInt(this.config.gasBudget); // e.g. 0.1 SUI
      const SUI_TYPE = '0x2::sui::SUI';
      const SUI_TYPE_FULL = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
      const isSuiCoinType = (ct: string) => ct === SUI_TYPE || ct === SUI_TYPE_FULL;
      const isSuiA = isSuiCoinType(poolInfo.coinTypeA);
      const isSuiB = isSuiCoinType(poolInfo.coinTypeB);
      
      const balanceABigInt = BigInt(balanceA.totalBalance);
      const balanceBBigInt = BigInt(balanceB.totalBalance);
      const safeBalanceA = isSuiA && balanceABigInt > SUI_GAS_RESERVE
        ? balanceABigInt - SUI_GAS_RESERVE
        : balanceABigInt;
      const safeBalanceB = isSuiB && balanceBBigInt > SUI_GAS_RESERVE
        ? balanceBBigInt - SUI_GAS_RESERVE
        : balanceBBigInt;
      
      let amountA: string;
      let amountB: string;
      
      if (preservedAmounts) {
        // Rebalancing: Use the exact token amounts that were removed from the old position
        // This ensures we preserve the liquidity VALUE when moving to a new tick range
        logger.info('Using preserved token amounts from removed position', {
          preservedAmountA: preservedAmounts.amountA,
          preservedAmountB: preservedAmounts.amountB,
          newTickRange: `[${tickLower}, ${tickUpper}]`,
        });
        
        // Use the exact amounts that were removed
        amountA = preservedAmounts.amountA;
        amountB = preservedAmounts.amountB;
        
        logger.info('Required token amounts for target liquidity VALUE', { 
          amountA, 
          amountB,
        });
      } else {
        // Initial position creation: use configured amounts or a portion of available balance
        const defaultMinAmount = 1000n;
        amountA = this.config.tokenAAmount || String(safeBalanceA > 0n ? safeBalanceA / 10n : defaultMinAmount);
        amountB = this.config.tokenBAmount || String(safeBalanceB > 0n ? safeBalanceB / 10n : defaultMinAmount);
        logger.info('Using configured amounts for initial position', { amountA, amountB });
      }

      // Check if we have insufficient balance and need to swap to meet the required amounts
      // Compare the REQUIRED amounts (not capped) with current wallet balances
      if (preservedAmounts) {
        const requiredA = BigInt(amountA);
        const requiredB = BigInt(amountB);
        const currentBalA = safeBalanceA;
        const currentBalB = safeBalanceB;
        
        const needsSwapForA = requiredA > currentBalA;
        const needsSwapForB = requiredB > currentBalB;
        
        if (needsSwapForA || needsSwapForB) {
          logger.info('Insufficient balance detected - swapping to meet required amounts', {
            requiredA: requiredA.toString(),
            currentBalA: currentBalA.toString(),
            requiredB: requiredB.toString(),
            currentBalB: currentBalB.toString(),
          });
          
          try {
            if (needsSwapForA && !needsSwapForB) {
              // Need more A, swap B → A
              const missingA = requiredA - currentBalA;
              const swapAmount = this.calculateSwapAmountWithBuffer(missingA);
              
              if (currentBalB >= swapAmount) {
                logger.info('Swapping Token B → Token A for missing amount', {
                  missing: missingA.toString(),
                  swapAmount: swapAmount.toString()
                });
                await this.performSwap(poolInfo, false, swapAmount.toString());
                
                // Update amountB to reflect what we have left after swap
                amountB = (currentBalB - swapAmount).toString();
              } else {
                logger.warn(`Insufficient Token B to swap for missing Token A. Need ${swapAmount.toString()}, have ${currentBalB.toString()}`);
              }
            } else if (needsSwapForB && !needsSwapForA) {
              // Need more B, swap A → B
              const missingB = requiredB - currentBalB;
              const swapAmount = this.calculateSwapAmountWithBuffer(missingB);
              
              if (currentBalA >= swapAmount) {
                logger.info('Swapping Token A → Token B for missing amount', {
                  missing: missingB.toString(),
                  swapAmount: swapAmount.toString()
                });
                await this.performSwap(poolInfo, true, swapAmount.toString());
                
                // Update amountA to reflect what we have left after swap
                amountA = (currentBalA - swapAmount).toString();
              } else {
                logger.warn(`Insufficient Token A to swap for missing Token B. Need ${swapAmount.toString()}, have ${currentBalA.toString()}`);
              }
            }
            
            // After swap, re-fetch balances and cap amounts to what's actually available
            const updatedBalanceA = await suiClient.getBalance({
              owner: ownerAddress,
              coinType: poolInfo.coinTypeA,
            });
            const updatedBalanceB = await suiClient.getBalance({
              owner: ownerAddress,
              coinType: poolInfo.coinTypeB,
            });
            
            const updatedBalA = BigInt(updatedBalanceA.totalBalance);
            const updatedBalB = BigInt(updatedBalanceB.totalBalance);
            const updatedSafeBalA = isSuiA && updatedBalA > SUI_GAS_RESERVE
              ? updatedBalA - SUI_GAS_RESERVE
              : updatedBalA;
            const updatedSafeBalB = isSuiB && updatedBalB > SUI_GAS_RESERVE
              ? updatedBalB - SUI_GAS_RESERVE
              : updatedBalB;
            
            // Use the minimum of required and available after swap
            amountA = (requiredA <= updatedSafeBalA ? requiredA : updatedSafeBalA).toString();
            amountB = (requiredB <= updatedSafeBalB ? requiredB : updatedSafeBalB).toString();
            
            logger.info('Amounts after swap adjustment', { amountA, amountB });
          } catch (swapError) {
            logger.warn('Swap failed, will use available balance', swapError);
            // Cap to available balance if swap fails
            amountA = currentBalA.toString();
            amountB = currentBalB.toString();
          }
        } else {
          // Both token balances are sufficient, proceed directly
          // Cap amounts to safe balance to handle edge cases (e.g., gas costs)
          logger.info('Token balances are sufficient, proceeding to add liquidity', {
            requiredA: requiredA.toString(),
            availableA: currentBalA.toString(),
            requiredB: requiredB.toString(),
            availableB: currentBalB.toString(),
          });
          amountA = (requiredA <= currentBalA ? requiredA : currentBalA).toString();
          amountB = (requiredB <= currentBalB ? requiredB : currentBalB).toString();
        }
      }

      // Refetch balances after all swap operations to get the CURRENT state
      // This is critical because remove liquidity and swap transactions consumed gas,
      // making the earlier balance calculations stale.
      const finalBalances = await Promise.all([
        suiClient.getBalance({
          owner: ownerAddress,
          coinType: poolInfo.coinTypeA,
        }),
        suiClient.getBalance({
          owner: ownerAddress,
          coinType: poolInfo.coinTypeB,
        }),
      ]);
      
      const finalBalanceA = BigInt(finalBalances[0].totalBalance);
      const finalBalanceB = BigInt(finalBalances[1].totalBalance);
      
      // Recalculate safe balances with gas reserve for the upcoming add liquidity transaction
      const finalSafeBalanceA = isSuiA && finalBalanceA > SUI_GAS_RESERVE
        ? finalBalanceA - SUI_GAS_RESERVE
        : finalBalanceA;
      const finalSafeBalanceB = isSuiB && finalBalanceB > SUI_GAS_RESERVE
        ? finalBalanceB - SUI_GAS_RESERVE
        : finalBalanceB;
      
      // Cap the amounts to the actual available balance after all operations
      const amountABigInt = BigInt(amountA);
      const amountBBigInt = BigInt(amountB);
      const finalAmountA = amountABigInt > finalSafeBalanceA ? finalSafeBalanceA : amountABigInt;
      const finalAmountB = amountBBigInt > finalSafeBalanceB ? finalSafeBalanceB : amountBBigInt;
      
      // Update amounts to the final capped values
      amountA = finalAmountA.toString();
      amountB = finalAmountB.toString();
      
      logger.info('Final amounts after balance refetch and gas reserve', {
        finalBalanceA: finalBalanceA.toString(),
        finalBalanceB: finalBalanceB.toString(),
        finalSafeBalanceA: finalSafeBalanceA.toString(),
        finalSafeBalanceB: finalSafeBalanceB.toString(),
        finalAmountA: amountA,
        finalAmountB: amountB,
      });
      
      // Validate amounts
      try {
        if (preservedAmounts) {
          // During rebalance with preserved liquidity VALUE, an out-of-range position may have all value in one token.
          if (finalAmountA === 0n && finalAmountB === 0n) {
            throw new Error('No tokens available for rebalancing. Wallet has insufficient balance of both tokens.');
          }
          // One token being zero is acceptable - we'll swap to get both tokens if needed
          if (finalAmountA === 0n || finalAmountB === 0n) {
            logger.info('One token is zero - will swap tokens if needed based on position range');
          }
        } else {
          // For initial position creation, we need both tokens
          if (finalAmountA === 0n || finalAmountB === 0n) {
            throw new Error('Insufficient token balance to add liquidity. Please ensure you have both tokens in your wallet.');
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('Cannot convert')) {
          throw new Error('Invalid token amount configuration');
        }
        throw error;
      }

      // Get current pool price to determine which token the new position will need
      const pool = await sdk.Pool.getPool(poolInfo.poolAddress);
      const currentTickIndex = pool.current_tick_index;
      
      // Determine which token(s) the new tick range will require based on current price
      // If current price is below the range: position only needs token A
      // If current price is above the range: position only needs token B
      // If current price is within the range: position needs both tokens
      const priceIsBelowRange = currentTickIndex < tickLower;
      const priceIsAboveRange = currentTickIndex >= tickUpper;
      const priceIsInRange = !priceIsBelowRange && !priceIsAboveRange;
      
      logger.info('Position range relative to current price', {
        currentTickIndex,
        tickLower,
        tickUpper,
        priceIsBelowRange,
        priceIsInRange,
        priceIsAboveRange,
      });
      
      // Check if we need to swap tokens before adding liquidity
      // This is critical when moving between out-of-range positions in opposite directions
      // or when moving to an in-range position with only one token available
      if (preservedAmounts) {
        const currentAmountABigInt = BigInt(amountA);
        const currentAmountBBigInt = BigInt(amountB);
        
        // Handle out-of-range positions that need only one token
        if (priceIsBelowRange || priceIsAboveRange) {
          if (priceIsBelowRange && currentAmountABigInt === 0n && currentAmountBBigInt > 0n) {
            // New position needs only token A, but we only have token B - need to swap B→A
            logger.info('Position is out-of-range (below) and requires token A, but we only have token B. Swapping...');
            
            try {
              // Swap all available token B to token A (false = B→A direction)
              await this.performSwap(poolInfo, false, amountB);
              
              // Refetch balances after swap
              const swappedBalances = await Promise.all([
                suiClient.getBalance({
                  owner: ownerAddress,
                  coinType: poolInfo.coinTypeA,
                }),
                suiClient.getBalance({
                  owner: ownerAddress,
                  coinType: poolInfo.coinTypeB,
                }),
              ]);
              
              // Calculate safe balances (reserve gas if token is SUI)
              const swappedBalanceA = BigInt(swappedBalances[0].totalBalance);
              const swappedBalanceB = BigInt(swappedBalances[1].totalBalance);
              const swappedSafeBalanceA = isSuiA && swappedBalanceA > SUI_GAS_RESERVE
                ? swappedBalanceA - SUI_GAS_RESERVE
                : swappedBalanceA;
              const swappedSafeBalanceB = isSuiB && swappedBalanceB > SUI_GAS_RESERVE
                ? swappedBalanceB - SUI_GAS_RESERVE
                : swappedBalanceB;
              
              amountA = swappedSafeBalanceA.toString();
              amountB = swappedSafeBalanceB.toString();
              
              logger.info('Amounts after B→A swap for out-of-range position', { amountA, amountB });
            } catch (swapError) {
              logger.error('Failed to swap B→A for out-of-range position', swapError);
              throw new Error(`Cannot add liquidity: position requires token A but only have token B, and swap failed: ${swapError instanceof Error ? swapError.message : String(swapError)}`);
            }
          } else if (priceIsAboveRange && currentAmountBBigInt === 0n && currentAmountABigInt > 0n) {
            // New position needs only token B, but we only have token A - need to swap A→B
            logger.info('Position is out-of-range (above) and requires token B, but we only have token A. Swapping...');
            
            try {
              // Swap all available token A to token B (true = A→B direction)
              await this.performSwap(poolInfo, true, amountA);
              
              // Refetch balances after swap
              const swappedBalances = await Promise.all([
                suiClient.getBalance({
                  owner: ownerAddress,
                  coinType: poolInfo.coinTypeA,
                }),
                suiClient.getBalance({
                  owner: ownerAddress,
                  coinType: poolInfo.coinTypeB,
                }),
              ]);
              
              // Calculate safe balances (reserve gas if token is SUI)
              const swappedBalanceA = BigInt(swappedBalances[0].totalBalance);
              const swappedBalanceB = BigInt(swappedBalances[1].totalBalance);
              const swappedSafeBalanceA = isSuiA && swappedBalanceA > SUI_GAS_RESERVE
                ? swappedBalanceA - SUI_GAS_RESERVE
                : swappedBalanceA;
              const swappedSafeBalanceB = isSuiB && swappedBalanceB > SUI_GAS_RESERVE
                ? swappedBalanceB - SUI_GAS_RESERVE
                : swappedBalanceB;
              
              amountA = swappedSafeBalanceA.toString();
              amountB = swappedSafeBalanceB.toString();
              
              logger.info('Amounts after A→B swap for out-of-range position', { amountA, amountB });
            } catch (swapError) {
              logger.error('Failed to swap A→B for out-of-range position', swapError);
              throw new Error(`Cannot add liquidity: position requires token B but only have token A, and swap failed: ${swapError instanceof Error ? swapError.message : String(swapError)}`);
            }
          }
        }
        // Handle in-range positions that need both tokens
        else if (priceIsInRange && (currentAmountABigInt === 0n || currentAmountBBigInt === 0n)) {
          // In-range position requires both tokens, but we only have one
          if (currentAmountABigInt === 0n && currentAmountBBigInt > 0n) {
            // We have only token B, need to swap half to get token A
            logger.info('Position is in-range and requires both tokens, but we only have token B. Swapping half to token A...');
            
            try {
              // Swap approximately half of token B to get token A (false = B→A direction)
              // Note: Using 50/50 split as a simple approximation. The SDK will calculate
              // the exact token ratio needed for the position range during add liquidity.
              const swapAmountB = currentAmountBBigInt / 2n;
              await this.performSwap(poolInfo, false, swapAmountB.toString());
              
              // Refetch balances after swap
              const swappedBalances = await Promise.all([
                suiClient.getBalance({
                  owner: ownerAddress,
                  coinType: poolInfo.coinTypeA,
                }),
                suiClient.getBalance({
                  owner: ownerAddress,
                  coinType: poolInfo.coinTypeB,
                }),
              ]);
              
              // Calculate safe balances (reserve gas if token is SUI)
              const swappedBalanceA = BigInt(swappedBalances[0].totalBalance);
              const swappedBalanceB = BigInt(swappedBalances[1].totalBalance);
              const swappedSafeBalanceA = isSuiA && swappedBalanceA > SUI_GAS_RESERVE
                ? swappedBalanceA - SUI_GAS_RESERVE
                : swappedBalanceA;
              const swappedSafeBalanceB = isSuiB && swappedBalanceB > SUI_GAS_RESERVE
                ? swappedBalanceB - SUI_GAS_RESERVE
                : swappedBalanceB;
              
              amountA = swappedSafeBalanceA.toString();
              amountB = swappedSafeBalanceB.toString();
              
              logger.info('Amounts after B→A swap for in-range position', { amountA, amountB });
            } catch (swapError) {
              logger.error('Failed to swap B→A for in-range position', swapError);
              throw new Error(`Cannot add liquidity: in-range position requires both tokens but only have token B, and swap failed: ${swapError instanceof Error ? swapError.message : String(swapError)}`);
            }
          } else if (currentAmountBBigInt === 0n && currentAmountABigInt > 0n) {
            // We have only token A, need to swap half to get token B
            logger.info('Position is in-range and requires both tokens, but we only have token A. Swapping half to token B...');
            
            try {
              // Swap approximately half of token A to get token B (true = A→B direction)
              // Note: Using 50/50 split as a simple approximation. The SDK will calculate
              // the exact token ratio needed for the position range during add liquidity.
              const swapAmountA = currentAmountABigInt / 2n;
              await this.performSwap(poolInfo, true, swapAmountA.toString());
              
              // Refetch balances after swap
              const swappedBalances = await Promise.all([
                suiClient.getBalance({
                  owner: ownerAddress,
                  coinType: poolInfo.coinTypeA,
                }),
                suiClient.getBalance({
                  owner: ownerAddress,
                  coinType: poolInfo.coinTypeB,
                }),
              ]);
              
              // Calculate safe balances (reserve gas if token is SUI)
              const swappedBalanceA = BigInt(swappedBalances[0].totalBalance);
              const swappedBalanceB = BigInt(swappedBalances[1].totalBalance);
              const swappedSafeBalanceA = isSuiA && swappedBalanceA > SUI_GAS_RESERVE
                ? swappedBalanceA - SUI_GAS_RESERVE
                : swappedBalanceA;
              const swappedSafeBalanceB = isSuiB && swappedBalanceB > SUI_GAS_RESERVE
                ? swappedBalanceB - SUI_GAS_RESERVE
                : swappedBalanceB;
              
              amountA = swappedSafeBalanceA.toString();
              amountB = swappedSafeBalanceB.toString();
              
              logger.info('Amounts after A→B swap for in-range position', { amountA, amountB });
            } catch (swapError) {
              logger.error('Failed to swap A→B for in-range position', swapError);
              throw new Error(`Cannot add liquidity: in-range position requires both tokens but only have token A, and swap failed: ${swapError instanceof Error ? swapError.message : String(swapError)}`);
            }
          }
        }
      }
      
      // Determine which token to fix based on available amounts and position range.
      // For out-of-range positions: fix the non-zero token so the SDK can compute the required counterpart (typically 0).
      // For in-range positions: fix the smaller amount to ensure both tokens can be fully utilized.
      //   - Fixing the smaller amount ensures the SDK's calculated requirement for the larger token
      //     won't exceed what we have available, maximizing liquidity provision with both tokens.
      let fixAmountA: boolean;
      if (priceIsInRange && BigInt(amountA) > 0n && BigInt(amountB) > 0n) {
        // In-range position with both tokens: fix the smaller amount
        fixAmountA = BigInt(amountA) <= BigInt(amountB);
      } else {
        // Out-of-range position or one token is 0: fix the larger/non-zero amount
        fixAmountA = BigInt(amountA) >= BigInt(amountB);
      }

      // Determine whether we need to open a new position or add to an existing one.
      // When opening a new position we use is_open: true so the SDK combines
      // open + add-liquidity into a single atomic transaction.  This avoids the
      // "object owned by another object" error that occurs when trying to use
      // a freshly-created position NFT as input to a separate add-liquidity tx.
      const isOpen = !existingPositionId;
      const positionId = existingPositionId || '';

      if (isOpen) {
        logger.info('Opening new position and adding liquidity in a single transaction', {
          amountA,
          amountB,
          tickLower,
          tickUpper,
        });
      } else {
        logger.info('Adding liquidity to existing position', {
          positionId,
          amountA,
          amountB,
          tickLower,
          tickUpper,
        });
      }

      // Use the SDK's fix token method which automatically calculates liquidity.
      // When is_open is true the SDK opens the position and adds liquidity atomically.
      // Convert tick values to strings to handle negative values correctly (SDK expects string | number)
      const addLiquidityParams: AddLiquidityFixTokenParams = {
        pool_id: poolInfo.poolAddress,
        pos_id: positionId,
        tick_lower: String(tickLower),
        tick_upper: String(tickUpper),
        amount_a: amountA,
        amount_b: amountB,
        slippage: this.config.maxSlippage,
        fix_amount_a: fixAmountA,
        is_open: isOpen,
        coinTypeA: poolInfo.coinTypeA,
        coinTypeB: poolInfo.coinTypeB,
        collect_fee: false,
        rewarder_coin_types: [],
      };
      
      // Add liquidity with retry logic and automatic swap recovery for insufficient balance
      logger.info('Executing add liquidity transaction...');
      
      let recoveryAttempted = false;
      let addResult;
      
      try {
        addResult = await this.retryAddLiquidity(
          async () => {
            // Refetch pool state on each retry to get latest version
            const pool = await sdk.Pool.getPool(poolInfo.poolAddress);
            const currentSqrtPrice = new BN(pool.current_sqrt_price);
            
            try {
              // Use createAddLiquidityFixTokenPayload which handles liquidity calculation
              const addLiquidityPayload = await sdk.Position.createAddLiquidityFixTokenPayload(
                addLiquidityParams as any,
                {
                  slippage: this.config.maxSlippage,
                  curSqrtPrice: currentSqrtPrice,
                }
              );
              addLiquidityPayload.setGasBudget(this.config.gasBudget);
              
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
            } catch (txError) {
              const errorMsg = txError instanceof Error ? txError.message : String(txError);
              
              // Check if this is an insufficient balance error and we haven't attempted recovery yet
              if (!recoveryAttempted && this.isInsufficientBalanceError(errorMsg)) {
                recoveryAttempted = true;
                logger.info('Insufficient balance detected, attempting swap recovery...');
                
                // Attempt swap recovery
                await this.attemptSwapRecovery(
                  poolInfo,
                  errorMsg,
                  amountA,
                  amountB,
                  ownerAddress,
                  suiClient
                );
                
                // After swap, retry the add liquidity operation once
                logger.info('Retrying add liquidity after swap recovery...');
                
                // Re-fetch pool state after swap
                const poolAfterSwap = await sdk.Pool.getPool(poolInfo.poolAddress);
                const currentSqrtPrice = new BN(poolAfterSwap.current_sqrt_price);
                
                const retryPayload = await sdk.Position.createAddLiquidityFixTokenPayload(
                  addLiquidityParams as any,
                  {
                    slippage: this.config.maxSlippage,
                    curSqrtPrice: currentSqrtPrice,
                  }
                );
                retryPayload.setGasBudget(this.config.gasBudget);
                
                const retryResult = await suiClient.signAndExecuteTransaction({
                  transaction: retryPayload,
                  signer: keypair,
                  options: {
                    showEffects: true,
                    showEvents: true,
                  },
                });
                
                if (retryResult.effects?.status?.status !== 'success') {
                  throw new Error(`Failed to add liquidity after recovery: ${retryResult.effects?.status?.error || 'Unknown error'}`);
                }
                
                return retryResult;
              }
              
              // If not an insufficient balance error or recovery already attempted, re-throw
              throw txError;
            }
          },
          3,
          3000
        );
      } catch (retryError) {
        // Add liquidity failed after all retry attempts
        // Implement fallback: open new position and retry once
        const originalError = retryError;
        
        // Only attempt fallback if we were opening a new position initially
        // If we were adding to an existing position, the fallback is to create a completely new position
        if (isOpen) {
          // Already tried to open a new position and it failed - throw original error
          throw originalError;
        }
        
        logger.warn('Add liquidity failed after retries, opening new position');
        
        try {
          // Step 1: Calculate required amounts for new position
          // Use the same amounts that were just attempted
          const requiredA = BigInt(amountA);
          const requiredB = BigInt(amountB);
          
          // Step 2: Check wallet balances
          const [currentBalanceA, currentBalanceB] = await Promise.all([
            suiClient.getBalance({
              owner: ownerAddress,
              coinType: poolInfo.coinTypeA,
            }),
            suiClient.getBalance({
              owner: ownerAddress,
              coinType: poolInfo.coinTypeB,
            }),
          ]);
          
          const walletBalanceA = BigInt(currentBalanceA.totalBalance);
          const walletBalanceB = BigInt(currentBalanceB.totalBalance);
          
          // Apply gas reserve if needed
          const SUI_GAS_RESERVE = BigInt(this.config.gasBudget);
          const SUI_TYPE = '0x2::sui::SUI';
          const SUI_TYPE_FULL = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
          const isSuiCoinType = (ct: string) => ct === SUI_TYPE || ct === SUI_TYPE_FULL;
          const isSuiA = isSuiCoinType(poolInfo.coinTypeA);
          const isSuiB = isSuiCoinType(poolInfo.coinTypeB);
          const safeBalanceA = isSuiA && walletBalanceA > SUI_GAS_RESERVE
            ? walletBalanceA - SUI_GAS_RESERVE
            : walletBalanceA;
          const safeBalanceB = isSuiB && walletBalanceB > SUI_GAS_RESERVE
            ? walletBalanceB - SUI_GAS_RESERVE
            : walletBalanceB;
          
          // Step 3: Check if balances are insufficient
          const isTokenAInsufficient = safeBalanceA < requiredA;
          const isTokenBInsufficient = safeBalanceB < requiredB;
          
          // Step 4: If insufficient, swap only the missing amount
          if (isTokenAInsufficient || isTokenBInsufficient) {
            logger.info('Insufficient balance for new position, swapping required amount');
            
            if (isTokenAInsufficient) {
              const missingAmountA = requiredA - safeBalanceA;
              const swapAmount = this.calculateSwapAmountWithBuffer(missingAmountA);
              
              if (safeBalanceB >= swapAmount) {
                logger.info(`Swapping Token B → Token A for missing amount`, { 
                  missing: missingAmountA.toString(),
                  swapAmount: swapAmount.toString()
                });
                await this.performSwap(poolInfo, false, swapAmount.toString());
              } else {
                throw new Error(`Insufficient Token B balance to swap for missing Token A. Need ${swapAmount.toString()}, have ${safeBalanceB.toString()}`);
              }
            } else if (isTokenBInsufficient) {
              const missingAmountB = requiredB - safeBalanceB;
              const swapAmount = this.calculateSwapAmountWithBuffer(missingAmountB);
              
              if (safeBalanceA >= swapAmount) {
                logger.info(`Swapping Token A → Token B for missing amount`, { 
                  missing: missingAmountB.toString(),
                  swapAmount: swapAmount.toString()
                });
                await this.performSwap(poolInfo, true, swapAmount.toString());
              } else {
                throw new Error(`Insufficient Token A balance to swap for missing Token B. Need ${swapAmount.toString()}, have ${safeBalanceA.toString()}`);
              }
            }
          }
          
          // Step 5: Open new position and retry add liquidity once
          logger.info('Retrying add liquidity on new position');
          
          // Convert tick values to strings to handle negative values correctly (SDK expects string | number)
          const newPositionParams: AddLiquidityFixTokenParams = {
            pool_id: poolInfo.poolAddress,
            pos_id: '', // Empty for new position
            tick_lower: String(tickLower),
            tick_upper: String(tickUpper),
            amount_a: amountA,
            amount_b: amountB,
            slippage: this.config.maxSlippage,
            fix_amount_a: fixAmountA,
            is_open: true, // Open new position
            coinTypeA: poolInfo.coinTypeA,
            coinTypeB: poolInfo.coinTypeB,
            collect_fee: false,
            rewarder_coin_types: [],
          };
          
          // Get fresh pool state
          const freshPool = await sdk.Pool.getPool(poolInfo.poolAddress);
          const freshSqrtPrice = new BN(freshPool.current_sqrt_price);
          
          const newPositionPayload = await sdk.Position.createAddLiquidityFixTokenPayload(
            newPositionParams as any,
            {
              slippage: this.config.maxSlippage,
              curSqrtPrice: freshSqrtPrice,
            }
          );
          newPositionPayload.setGasBudget(this.config.gasBudget);
          
          const newPositionResult = await suiClient.signAndExecuteTransaction({
            transaction: newPositionPayload,
            signer: keypair,
            options: {
              showEffects: true,
              showEvents: true,
            },
          });
          
          if (newPositionResult.effects?.status?.status !== 'success') {
            throw new Error(`Failed to add liquidity on new position: ${newPositionResult.effects?.status?.error || 'Unknown error'}`);
          }
          
          // Step 6: Success - log and return
          logger.info('Liquidity added successfully on new position', {
            digest: newPositionResult.digest,
            amountA,
            amountB,
          });
          
          addResult = newPositionResult;
        } catch (fallbackError) {
          // Step 7: Fallback failed - throw original error
          logger.error('Fallback attempt failed, throwing original error', fallbackError);
          throw originalError;
        }
      }
      
      logger.info('Liquidity added successfully', {
        digest: addResult.digest,
        positionId: isOpen ? '(new position)' : positionId,
        amountA,
        amountB,
      });
      
      return {
        transactionDigest: addResult.digest,
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
      // Fetch current pool state and all positions for this pool
      const poolInfo = await this.monitorService.getPoolInfo(poolAddress);
      const ownerAddress = this.sdkService.getAddress();
      const allPositions = await this.monitorService.getPositions(ownerAddress);
      // Filter positions for this pool and exclude positions with zero liquidity
      const poolPositions = allPositions.filter(p => {
        if (p.poolAddress !== poolAddress) return false;
        if (!p.liquidity || p.liquidity === '') return false;
        try {
          return BigInt(p.liquidity) > 0n;
        } catch {
          return false;
        }
      });

      // Determine which single position to track and rebalance.
      // The bot always manages exactly ONE position at a time.
      let trackedPosition: PositionInfo | undefined;

      if (this.trackedPositionId) {
        // Use the explicitly tracked position (from config or previous rebalance)
        trackedPosition = poolPositions.find(p => p.positionId === this.trackedPositionId);
        if (!trackedPosition) {
          logger.warn(`Tracked position ${this.trackedPositionId} not found in pool — skipping`);
          return null;
        }
      } else if (poolPositions.length > 0) {
        // Auto-track: pick the position with the most liquidity
        const sorted = [...poolPositions].sort((a, b) => {
          const liqA = BigInt(a.liquidity || '0');
          const liqB = BigInt(b.liquidity || '0');
          if (liqA > liqB) return -1;
          if (liqA < liqB) return 1;
          return 0;
        });
        trackedPosition = sorted[0];
        this.trackedPositionId = trackedPosition.positionId;
        logger.info('Auto-tracking position with most liquidity', {
          positionId: this.trackedPositionId,
          liquidity: trackedPosition.liquidity,
        });
      } else {
        logger.info('No existing positions with liquidity > 0 found in pool — nothing to rebalance');
        return null;
      }

      // Check if the tracked position needs rebalancing
      const isInRange = this.monitorService.isPositionInRange(
        trackedPosition.tickLower,
        trackedPosition.tickUpper,
        poolInfo.currentTickIndex,
      );

      if (isInRange && !this.monitorService.shouldRebalance(trackedPosition, poolInfo)) {
        logger.info(
          `Tracked position ${trackedPosition.positionId} is in range ` +
          `[${trackedPosition.tickLower}, ${trackedPosition.tickUpper}] at tick ${poolInfo.currentTickIndex} — no action needed`,
        );
        return null;
      }

      logger.info(
        `Tracked position ${trackedPosition.positionId} is OUT of range ` +
        `[${trackedPosition.tickLower}, ${trackedPosition.tickUpper}] at tick ${poolInfo.currentTickIndex} — rebalance needed`,
      );
      return await this.rebalancePosition(poolAddress);
    } catch (error) {
      logger.error('Check and rebalance failed', error);
      throw error;
    }
  }
}
