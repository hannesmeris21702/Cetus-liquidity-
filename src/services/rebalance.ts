import { CetusSDKService } from './sdk';
import { PositionMonitorService, PoolInfo, PositionInfo } from './monitor';
import { BotConfig } from '../config';
import { logger } from '../utils/logger';
import BN from 'bn.js';
import type { BalanceChange } from '@mysten/sui/client';
import type { SwapParams } from '@cetusprotocol/cetus-sui-clmm-sdk';

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

  // Scale factor for bigint slippage arithmetic (basis points denominator).
  private static readonly SLIPPAGE_SCALE = 10_000n;

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

      let closedPositionAmounts: { amountA: string; amountB: string } | undefined;

      if (hasLiquidity) {
        // Remove liquidity from old position and capture the freed token amounts.
        // These are used as the zap inputs for the new position so only the
        // tokens freed from the closed position are re-deployed.
        closedPositionAmounts = await this.removeLiquidity(position.positionId, position.liquidity);
        logger.info('Successfully removed liquidity from old position', {
          positionId: position.positionId,
          amountA: closedPositionAmounts.amountA,
          amountB: closedPositionAmounts.amountB,
        });
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

      // Save the old tracked position ID and clear tracking before attempting add liquidity
      // This prevents the bot from tracking a position with zero liquidity if add liquidity fails
      const oldTrackedPositionId = this.trackedPositionId;
      const isCreatingNewPosition = !existingInRangePosition && hasLiquidity;
      
      if (isCreatingNewPosition) {
        // We're creating a new position and removed liquidity from old one
        // Clear tracking temporarily until we confirm the new position is created
        this.trackedPositionId = null;
        logger.info('Cleared tracked position ID - will update after successful add liquidity', {
          oldPositionId: oldTrackedPositionId,
        });
      }

      // Add liquidity to existing in-range position or create a new one.
      // When closedPositionAmounts are available the zap uses the freed token
      // amounts rather than the full wallet balance, so the new position
      // receives exactly the liquidity that was released from the old one.
      let result;
      try {
        result = await this.addLiquidity(
          poolInfo,
          lower,
          upper,
          existingInRangePosition?.positionId,
          closedPositionAmounts,
        );
      } catch (addLiquidityError) {
        // Add liquidity failed - if we cleared tracking, keep it cleared so bot can recover
        // We don't restore oldTrackedPositionId because that position now has zero liquidity
        // and would be filtered out in subsequent checks. Keeping it null allows auto-tracking.
        if (isCreatingNewPosition) {
          logger.warn('Add liquidity failed after removing liquidity from tracked position. Tracking cleared to allow recovery.', {
            oldPositionId: oldTrackedPositionId,
            reason: 'Old position has zero liquidity and would be filtered out',
          });
        }
        throw addLiquidityError;
      }

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
          } else {
            // Couldn't find new position - keep tracking cleared (null)
            // Don't restore oldTrackedPositionId because it has zero liquidity
            logger.warn('Could not find newly created position. Tracking will remain cleared.', {
              oldPositionId: oldTrackedPositionId,
              reason: 'Will allow auto-tracking in next cycle',
            });
          }
        } catch (err) {
          logger.warn('Could not discover new position ID after rebalance', {
            error: err,
            oldPositionId: oldTrackedPositionId,
          });
          // Keep tracking cleared if we couldn't discover the new position
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

  private async removeLiquidity(positionId: string, liquidity: string): Promise<{ amountA: string; amountB: string }> {
    try {
      logger.info('Removing liquidity', { positionId, liquidity });

      const sdk = this.sdkService.getSdk();
      const keypair = this.sdkService.getKeypair();
      const suiClient = this.sdkService.getSuiClient();
      const ownerAddress = this.sdkService.getAddress();

      // Track coin types so we can parse balance changes after the transaction
      let coinTypeA = '';
      let coinTypeB = '';

      // Pre-tx wallet balance snapshot for fallback when balance-change parsing
      // yields 0 for both tokens.  Updated inside the retry callback before each
      // attempt so the snapshot always matches the transaction that succeeds.
      let preTxBalanceA = 0n;
      let preTxBalanceB = 0n;

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

          coinTypeA = position.tokenA;
          coinTypeB = position.tokenB;

          // Snapshot wallet balances immediately before the transaction so that
          // a post-tx comparison can determine freed amounts if balance-change
          // parsing fails (e.g. net SUI change is negative due to gas costs).
          const [preBalA, preBalB] = await Promise.all([
            suiClient.getBalance({ owner: ownerAddress, coinType: coinTypeA }),
            suiClient.getBalance({ owner: ownerAddress, coinType: coinTypeB }),
          ]);
          preTxBalanceA = BigInt(preBalA.totalBalance);
          preTxBalanceB = BigInt(preBalB.totalBalance);

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
              showBalanceChanges: true,
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

      // Parse balance changes to determine how many tokens were returned to the wallet.
      // A positive balance change for the owner address means tokens were received.
      const normalizedTypeA = this.normalizeCoinType(coinTypeA);
      const normalizedTypeB = this.normalizeCoinType(coinTypeB);

      let amountA = '0';
      let amountB = '0';

      const balanceChanges: BalanceChange[] | null | undefined = result.balanceChanges;

      // Compute total gas paid so we can recover the gross SUI amount freed from
      // the position.  When gas > SUI held in the position the net SUI balance
      // change is negative and would otherwise be filtered out, leaving both
      // amounts as 0 and triggering an incorrect wallet-balance fallback.
      const gasUsed = result.effects?.gasUsed;
      const totalGasCost = gasUsed
        ? BigInt(gasUsed.computationCost) + BigInt(gasUsed.storageCost) - BigInt(gasUsed.storageRebate)
        : 0n;
      const normalizedSuiType = this.normalizeCoinType('0x2::sui::SUI');

      if (balanceChanges) {
        for (const change of balanceChanges) {
          const owner = change.owner;
          if (typeof owner !== 'object' || !('AddressOwner' in owner)) continue;
          if ((owner as { AddressOwner: string }).AddressOwner.toLowerCase() !== ownerAddress.toLowerCase()) continue;
          let amt = BigInt(change.amount);
          // For SUI the net balance change includes gas deduction and may be
          // negative even when the position freed tokens.  Add back the total gas
          // cost to recover the gross amount received from the position.
          if (amt < 0n && totalGasCost > 0n && this.normalizeCoinType(change.coinType) === normalizedSuiType) {
            const gross = amt + totalGasCost;
            amt = gross > 0n ? gross : 0n;
          }
          if (amt <= 0n) continue;
          const normalizedType = this.normalizeCoinType(change.coinType);
          if (normalizedType === normalizedTypeA) {
            amountA = (BigInt(amountA) + amt).toString();
          } else if (normalizedType === normalizedTypeB) {
            amountB = (BigInt(amountB) + amt).toString();
          }
        }
      }

      // Fallback: if balance-change parsing returned 0 for both tokens, compare
      // the post-tx wallet balance against the pre-tx snapshot to determine how
      // many tokens were actually freed by the close-position transaction.
      // This handles cases where the RPC omits balance changes or gas arithmetic
      // makes the net SUI change appear non-positive.
      if (amountA === '0' && amountB === '0' && coinTypeA !== '' && coinTypeB !== '') {
        logger.warn('Balance-change parsing yielded 0 for both tokens — comparing pre/post wallet balances to detect freed amounts');
        const [postBalA, postBalB] = await Promise.all([
          suiClient.getBalance({ owner: ownerAddress, coinType: coinTypeA }),
          suiClient.getBalance({ owner: ownerAddress, coinType: coinTypeB }),
        ]);
        const deltaA = BigInt(postBalA.totalBalance) - preTxBalanceA;
        const deltaB = BigInt(postBalB.totalBalance) - preTxBalanceB;
        if (deltaA > 0n) {
          amountA = deltaA.toString();
        } else {
          logger.warn('Post-tx balance delta for tokenA is not positive', { deltaA: deltaA.toString(), coinTypeA });
        }
        if (deltaB > 0n) {
          amountB = deltaB.toString();
        } else {
          logger.warn('Post-tx balance delta for tokenB is not positive', { deltaB: deltaB.toString(), coinTypeB });
        }
        logger.info('Freed amounts from pre/post wallet balance comparison', { amountA, amountB });
      }

      logger.info('Liquidity removed successfully', {
        digest: result.digest,
        gasUsed: result.effects?.gasUsed,
        amountA,
        amountB,
      });

      return { amountA, amountB };
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
        
        // MoveAbort errors are contract-level failures that cannot be resolved
        // by retrying with the same parameters — throw immediately.
        if (errorMsg.includes('MoveAbort')) {
          logger.error(`Non-retryable MoveAbort error in add liquidity: ${errorMsg}`);
          throw error;
        }

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

  /** Normalise a coin type string for comparison (lowercased, leading zeros stripped). */
  private normalizeCoinType(ct: string): string {
    return ct.toLowerCase().replace(/^0x0+/, '0x');
  }

  /**
   * Determine which token amount to fix when calling createAddLiquidityFixTokenPayload.
   *
   * The Cetus CLMM Move contract's get_liquidity_by_amount aborts with error 3018 when:
   *   - fix_amount_a=true  and current price >= upper tick (price at/above range)
   *   - fix_amount_a=false and current price <  lower tick (price below range)
   * Therefore for out-of-range positions the direction MUST be set by the price range,
   * not by the token amounts.
   *
   * @param currentTickIndex - current pool tick index
   * @param tickLower - position lower tick
   * @param tickUpper - position upper tick
   * @param amountA - available token A amount (as string)
   * @param amountB - available token B amount (as string)
   * @returns true to fix token A, false to fix token B
   */
  private determineFixAmountA(
    currentTickIndex: number,
    tickLower: number,
    tickUpper: number,
    amountA: string,
    amountB: string,
  ): boolean {
    if (currentTickIndex < tickLower) {
      // Price below range: only token A is needed; fixing token B would cause error 3018
      return true;
    }
    if (currentTickIndex >= tickUpper) {
      // Price at/above range: only token B is needed; fixing token A would cause error 3018
      return false;
    }
    // Price is in range: fix whichever token we have more of (or A if equal)
    return BigInt(amountA) >= BigInt(amountB);
  }

  /**
   * Calculate the amount to use for a single token in the zap call when
   * rebalancing from a closed position.
   *
   * @param removedAmount - token amount received from closing the old position
   * @param safeBalance   - current wallet balance after reserving gas
   * @returns amount to pass to the SDK (as a string)
   */
  private calculateZapAmount(removedAmount: bigint, safeBalance: bigint): string {
    if (removedAmount <= 0n) return '0';
    // If the balance query returned 0 but we received a positive amount from
    // closing the position, the on-chain state may not yet be reflected in the
    // balance RPC response.  Trust the closed-position amount so the zap can
    // proceed with the tokens that were just returned to the wallet.
    if (safeBalance === 0n) return removedAmount.toString();
    return (removedAmount <= safeBalance ? removedAmount : safeBalance).toString();
  }

  /**
   * Perform a swap of approximately half of a single-token balance so that
   * both tokens are available for adding to an in-range position (zap in).
   *
   * @param poolInfo   - pool metadata
   * @param aToB       - true = swap tokenA → tokenB, false = swap tokenB → tokenA
   * @param swapAmount - raw amount of the input token to swap (≈ half of total)
   * @param preSwapA   - tokenA amount BEFORE the swap (for post-swap calculation)
   * @param preSwapB   - tokenB amount BEFORE the swap (for post-swap calculation)
   * @returns updated { amountA, amountB } to use for the addLiquidity call
   */
  private async performZapInSwap(
    poolInfo: PoolInfo,
    aToB: boolean,
    swapAmount: bigint,
    preSwapA: bigint,
    preSwapB: bigint,
  ): Promise<{ amountA: string; amountB: string }> {
    const sdk = this.sdkService.getSdk();
    const keypair = this.sdkService.getKeypair();
    const suiClient = this.sdkService.getSuiClient();
    const ownerAddress = this.sdkService.getAddress();

    logger.info('Zap-in: performing pre-swap to obtain both tokens', {
      aToB,
      swapAmount: swapAmount.toString(),
    });

    // Estimate the swap output to set a meaningful amount_limit (min out with slippage).
    let amountLimit = '0';
    try {
      const pool = await sdk.Pool.getPool(poolInfo.poolAddress);
      const preswapResult = await sdk.Swap.preswap({
        pool,
        currentSqrtPrice: pool.current_sqrt_price,
        coinTypeA: poolInfo.coinTypeA,
        coinTypeB: poolInfo.coinTypeB,
        decimalsA: 9,
        decimalsB: 9,
        a2b: aToB,
        byAmountIn: true,
        amount: swapAmount.toString(),
      });
      if (preswapResult && !preswapResult.isExceed) {
        const estimatedOut = BigInt(preswapResult.estimatedAmountOut);
        // Apply slippage tolerance to get the minimum acceptable output.
        const slippageFactor = BigInt(Math.floor((1 - this.config.maxSlippage) * Number(RebalanceService.SLIPPAGE_SCALE)));
        amountLimit = ((estimatedOut * slippageFactor) / RebalanceService.SLIPPAGE_SCALE).toString();
        logger.info('Zap-in swap estimate', {
          estimatedAmountOut: preswapResult.estimatedAmountOut,
          amountLimit,
        });
      }
    } catch (err) {
      logger.warn('Zap-in preswap estimate failed — proceeding with amount_limit=0', { error: err });
    }

    // Build and execute the swap transaction.
    const swapParams: SwapParams = {
      pool_id: poolInfo.poolAddress,
      coinTypeA: poolInfo.coinTypeA,
      coinTypeB: poolInfo.coinTypeB,
      a2b: aToB,
      by_amount_in: true,
      amount: swapAmount.toString(),
      amount_limit: amountLimit,
    };

    const swapPayload = await sdk.Swap.createSwapTransactionPayload(swapParams);
    swapPayload.setGasBudget(this.config.gasBudget);

    const swapResult = await suiClient.signAndExecuteTransaction({
      transaction: swapPayload,
      signer: keypair,
      options: { showEffects: true, showBalanceChanges: true },
    });

    if (swapResult.effects?.status?.status !== 'success') {
      throw new Error(`Zap-in swap failed: ${swapResult.effects?.status?.error || 'Unknown error'}`);
    }

    logger.info('Zap-in swap executed', { digest: swapResult.digest });

    // Derive post-swap amounts from balance changes reported by the transaction.
    // Falls back to re-querying the wallet if the balance changes cannot be parsed.
    const SUI_GAS_RESERVE = BigInt(this.config.gasBudget);
    const SUI_TYPE = '0x2::sui::SUI';
    const SUI_TYPE_FULL = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
    const isSuiCoinType = (ct: string) => ct === SUI_TYPE || ct === SUI_TYPE_FULL;

    const normalizedTypeA = this.normalizeCoinType(poolInfo.coinTypeA);
    const normalizedTypeB = this.normalizeCoinType(poolInfo.coinTypeB);

    let swapDeltaA = 0n;
    let swapDeltaB = 0n;
    const balanceChanges: BalanceChange[] | null | undefined = swapResult.balanceChanges;
    if (balanceChanges) {
      for (const change of balanceChanges) {
        const owner = change.owner;
        if (typeof owner !== 'object' || !('AddressOwner' in owner)) continue;
        if ((owner as { AddressOwner: string }).AddressOwner.toLowerCase() !== ownerAddress.toLowerCase()) continue;
        const normalizedType = this.normalizeCoinType(change.coinType);
        if (normalizedType === normalizedTypeA) swapDeltaA += BigInt(change.amount);
        else if (normalizedType === normalizedTypeB) swapDeltaB += BigInt(change.amount);
      }
    }

    let adjA = preSwapA + swapDeltaA;
    let adjB = preSwapB + swapDeltaB;

    // If balance changes didn't give usable deltas, re-query the wallet.
    if (adjA <= 0n && adjB <= 0n) {
      logger.warn('Zap-in swap: balance change parsing yielded 0 — re-querying wallet balances');
      const [balA, balB] = await Promise.all([
        suiClient.getBalance({ owner: ownerAddress, coinType: poolInfo.coinTypeA }),
        suiClient.getBalance({ owner: ownerAddress, coinType: poolInfo.coinTypeB }),
      ]);
      adjA = BigInt(balA.totalBalance);
      adjB = BigInt(balB.totalBalance);
    }

    // Reserve gas when a token is SUI.
    if (isSuiCoinType(poolInfo.coinTypeA) && adjA > SUI_GAS_RESERVE) adjA -= SUI_GAS_RESERVE;
    if (isSuiCoinType(poolInfo.coinTypeB) && adjB > SUI_GAS_RESERVE) adjB -= SUI_GAS_RESERVE;

    const amountA = (adjA > 0n ? adjA : 0n).toString();
    const amountB = (adjB > 0n ? adjB : 0n).toString();

    logger.info('Zap-in swap complete — updated token amounts', { amountA, amountB });
    return { amountA, amountB };
  }

   /**
    * Add liquidity using the SDK's fix-token (zap) method.
    *
    * When closedPositionAmounts are provided (rebalancing case) the method uses
   * those freed token amounts as the zap inputs instead of the full wallet
   * balance.  This ensures the new position is funded exclusively by the
   * liquidity that was released from the closed out-of-range position:
   *
   *  - Freed amount > 0 and ≤ safe wallet balance → use the freed amount
   *  - Freed amount > safe wallet balance          → cap to safe wallet balance
   *  - Freed amount is 0 / undefined               → use 0 (not wallet balance)
   *
   * When no closedPositionAmounts are given (new position from scratch) the
   * original wallet-balance logic applies:
   *
   *  - Position below range  → only token A needed; amount_b = 0
   *  - Position above range  → only token B needed; amount_a = 0
   *  - Position in range     → provide both tokens; SDK calculates ratio from the fixed token
   *
   * Zap-in: When an in-range position has only one token available (e.g. because
   * the old position was single-sided), the method automatically swaps half of
   * the available token to obtain both tokens before adding liquidity.
   */
  private async addLiquidity(
    poolInfo: PoolInfo,
    tickLower: number,
    tickUpper: number,
    existingPositionId?: string,
    closedPositionAmounts?: { amountA: string; amountB: string },
  ): Promise<{ transactionDigest?: string }> {
    try {
      logger.info('Adding liquidity using zap method', {
        poolAddress: poolInfo.poolAddress,
        tickLower,
        tickUpper,
      });

      const sdk = this.sdkService.getSdk();
      const keypair = this.sdkService.getKeypair();
      const suiClient = this.sdkService.getSuiClient();
      const ownerAddress = this.sdkService.getAddress();

      // Reserve gas when a token is SUI so the transaction does not spend the
      // entire balance and fail with balance::split.
      const SUI_GAS_RESERVE = BigInt(this.config.gasBudget);
      const SUI_TYPE = '0x2::sui::SUI';
      const SUI_TYPE_FULL = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
      const isSuiCoinType = (ct: string) => ct === SUI_TYPE || ct === SUI_TYPE_FULL;
      const isSuiA = isSuiCoinType(poolInfo.coinTypeA);
      const isSuiB = isSuiCoinType(poolInfo.coinTypeB);

      const [balanceA, balanceB] = await Promise.all([
        suiClient.getBalance({ owner: ownerAddress, coinType: poolInfo.coinTypeA }),
        suiClient.getBalance({ owner: ownerAddress, coinType: poolInfo.coinTypeB }),
      ]);

      const rawBalanceA = BigInt(balanceA.totalBalance);
      const rawBalanceB = BigInt(balanceB.totalBalance);
      const safeBalanceA = isSuiA && rawBalanceA > SUI_GAS_RESERVE ? rawBalanceA - SUI_GAS_RESERVE : rawBalanceA;
      const safeBalanceB = isSuiB && rawBalanceB > SUI_GAS_RESERVE ? rawBalanceB - SUI_GAS_RESERVE : rawBalanceB;

      logger.info('Token balances', {
        tokenA: safeBalanceA.toString(),
        tokenB: safeBalanceB.toString(),
        coinTypeA: poolInfo.coinTypeA,
        coinTypeB: poolInfo.coinTypeB,
      });

      if (safeBalanceA === 0n && safeBalanceB === 0n) {
        // When rebalancing, tokens come from the just-closed position and the
        // balance RPC may not yet reflect the completed transaction.  Skip this
        // guard if we have non-zero closed-position amounts to work with.
        const hasClosedAmounts =
          closedPositionAmounts &&
          (BigInt(closedPositionAmounts.amountA) > 0n || BigInt(closedPositionAmounts.amountB) > 0n);
        if (!hasClosedAmounts) {
          throw new Error('No tokens available to add liquidity. Please ensure wallet has sufficient balance.');
        }
      }

      // Fetch current pool state to determine position range
      const pool = await sdk.Pool.getPool(poolInfo.poolAddress);
      const currentTickIndex = pool.current_tick_index;
      const priceIsBelowRange = currentTickIndex < tickLower;
      const priceIsAboveRange = currentTickIndex >= tickUpper;

      logger.info('Position range relative to current price', {
        currentTickIndex,
        tickLower,
        tickUpper,
        priceIsBelowRange,
        priceIsInRange: !priceIsBelowRange && !priceIsAboveRange,
        priceIsAboveRange,
      });

      // Select token amounts for the zap call.
      let amountA: string;
      let amountB: string;

      if (closedPositionAmounts) {
        const removedA = BigInt(closedPositionAmounts.amountA);
        const removedB = BigInt(closedPositionAmounts.amountB);
        if (removedA > 0n || removedB > 0n) {
          // Rebalancing: use only the tokens freed from the closed position.
          // Cap each amount at the safe wallet balance in case gas consumed some SUI.
          amountA = this.calculateZapAmount(removedA, safeBalanceA);
          amountB = this.calculateZapAmount(removedB, safeBalanceB);
          logger.info('Using closed position token amounts for zap', {
            removedA: closedPositionAmounts.amountA,
            removedB: closedPositionAmounts.amountB,
            amountA,
            amountB,
          });
        } else {
          // Balance change parsing returned 0 for both tokens (e.g. net SUI change
          // was negative due to gas cost exceeding the SUI held in the position).
          // Fall back to wallet balance so the freed tokens can still be used.
          logger.warn('Closed position amounts are both 0 — falling back to wallet balance for zap', {
            safeBalanceA: safeBalanceA.toString(),
            safeBalanceB: safeBalanceB.toString(),
          });
          if (priceIsBelowRange) {
            amountA = safeBalanceA.toString();
            amountB = '0';
          } else if (priceIsAboveRange) {
            amountA = '0';
            amountB = safeBalanceB.toString();
          } else {
            amountA = safeBalanceA.toString();
            amountB = safeBalanceB.toString();
          }
        }
      } else if (priceIsBelowRange) {
        // Only token A is needed for a below-range position
        amountA = safeBalanceA.toString();
        amountB = '0';
      } else if (priceIsAboveRange) {
        // Only token B is needed for an above-range position
        amountA = '0';
        amountB = safeBalanceB.toString();
      } else {
        // In-range position: provide both available token amounts.
        // The SDK uses fix_amount_a to calculate the correct counterpart amount.
        amountA = safeBalanceA.toString();
        amountB = safeBalanceB.toString();
      }

      if (BigInt(amountA) === 0n && BigInt(amountB) === 0n) {
        throw new Error('Insufficient token balance for this position range. Please add tokens to your wallet.');
      }

      // Zap-in: when the new position is in-range but we only have one token,
      // swap approximately half of it so both tokens are available for the
      // add-liquidity call.  This is the core "zap in" behaviour.
      if (!priceIsBelowRange && !priceIsAboveRange) {
        const bigAmountA = BigInt(amountA);
        const bigAmountB = BigInt(amountB);
        const oneIsZero =
          (bigAmountA > 0n && bigAmountB === 0n) ||
          (bigAmountA === 0n && bigAmountB > 0n);

        if (oneIsZero) {
          const aToB = bigAmountA > 0n;
          const swapAmount = (aToB ? bigAmountA : bigAmountB) / 2n;

          if (swapAmount > 0n) {
            const updated = await this.performZapInSwap(
              poolInfo, aToB, swapAmount, bigAmountA, bigAmountB,
            );
            amountA = updated.amountA;
            amountB = updated.amountB;
          }
        }
      }

      const isOpen = !existingPositionId;
      const positionId = existingPositionId || '';

      const addLiquidityParams: AddLiquidityFixTokenParams = {
        pool_id: poolInfo.poolAddress,
        pos_id: positionId,
        tick_lower: String(tickLower),
        tick_upper: String(tickUpper),
        amount_a: amountA,
        amount_b: amountB,
        slippage: this.config.maxSlippage,
        fix_amount_a: this.determineFixAmountA(currentTickIndex, tickLower, tickUpper, amountA, amountB),
        is_open: isOpen,
        coinTypeA: poolInfo.coinTypeA,
        coinTypeB: poolInfo.coinTypeB,
        collect_fee: false,
        rewarder_coin_types: [],
      };

      logger.info(`${isOpen ? 'Opening new position' : 'Adding to existing position'} with zap method`, {
        amountA,
        amountB,
        fix_amount_a: addLiquidityParams.fix_amount_a,
      });

      const addResult = await this.retryAddLiquidity(
        async () => {
          // Refetch pool state on each retry for fresh sqrt price and tick index.
          // Re-evaluating fix_amount_a prevents error 3018 when price moves between retries.
          const freshPool = await sdk.Pool.getPool(poolInfo.poolAddress);
          const freshSqrtPrice = new BN(freshPool.current_sqrt_price);
          addLiquidityParams.fix_amount_a = this.determineFixAmountA(
            freshPool.current_tick_index,
            tickLower,
            tickUpper,
            amountA,
            amountB,
          );

          const payload = await sdk.Position.createAddLiquidityFixTokenPayload(
            addLiquidityParams as any,
            { slippage: this.config.maxSlippage, curSqrtPrice: freshSqrtPrice },
          );
          payload.setGasBudget(this.config.gasBudget);

          const result = await suiClient.signAndExecuteTransaction({
            transaction: payload,
            signer: keypair,
            options: { showEffects: true, showEvents: true },
          });

          if (result.effects?.status?.status !== 'success') {
            throw new Error(`Failed to add liquidity: ${result.effects?.status?.error || 'Unknown error'}`);
          }

          return result;
        },
        3,
        3000,
      );

      logger.info('Liquidity added successfully', {
        digest: addResult.digest,
        positionId: isOpen ? '(new position)' : positionId,
        amountA,
        amountB,
      });

      return { transactionDigest: addResult.digest };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`Failed to add liquidity: ${errorMsg}`);
      if (errorStack) {
        logger.error('Stack trace:', errorStack);
      }

      if (errorMsg.includes('insufficient') || errorMsg.includes('balance')) {
        logger.error('Insufficient token balance. Please ensure you have tokens in your wallet.');
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
        // No positions with liquidity > 0.  Attempt to create a new one from
        // wallet balance so the bot can recover after a failed rebalance cycle
        // (where remove liquidity succeeded but add liquidity failed, leaving
        // the freed tokens sitting in the wallet).
        logger.info('No existing positions with liquidity > 0 found in pool — attempting to open a new position from wallet balance');
        const recoveryResult = await this.createNewPosition(poolInfo);
        // Only surface a non-null result when creation actually succeeded;
        // failures (e.g. no wallet balance) are already logged inside
        // createNewPosition and we don't want spurious "Rebalance executed"
        // failure entries in the main check loop.
        return recoveryResult.success ? recoveryResult : null;
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
