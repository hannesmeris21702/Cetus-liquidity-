import { CetusSDKService } from './sdk';
import { PositionMonitorService, PoolInfo, PositionInfo } from './monitor';
import { BotConfig } from '../config';
import { logger } from '../utils/logger';
import BN from 'bn.js';
import { TickMath, estimateLiquidityForCoinA, estimateLiquidityForCoinB } from '@cetusprotocol/cetus-sui-clmm-sdk';
import type { SwapParams } from '@cetusprotocol/cetus-sui-clmm-sdk';
import type { BalanceChange } from '@mysten/sui/client';

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

type QuoteSide = { token: 'A' | 'B'; amount: string; liquidity: BN };
const labelForToken = (token: 'A' | 'B') => token === 'A' ? 'TOKEN_A_AMOUNT' : 'TOKEN_B_AMOUNT';

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

      // Calculate the new optimal range.
      // Priority order:
      //  1. LOWER_TICK + UPPER_TICK env vars → use exact ticks.
      //  2. RANGE_WIDTH env var → centre the configured width around the current tick.
      //  3. Tracking a specific position (and no RANGE_WIDTH) → preserve its range width.
      //  4. Default → tightest active range (single tick-spacing bin).
      let lower: number;
      let upper: number;
      if (this.config.lowerTick !== undefined && this.config.upperTick !== undefined) {
        lower = this.config.lowerTick;
        upper = this.config.upperTick;
        logger.info('Using env-configured tick range for new position', { lower, upper });
      } else {
        // Use RANGE_WIDTH from env when set; only preserve the old position
        // width as a fallback when no explicit range width is configured.
        const preserveWidth = this.trackedPositionId && !this.config.rangeWidth
          ? position.tickUpper - position.tickLower
          : undefined;
        ({ lower, upper } = this.monitorService.calculateOptimalRange(
          poolInfo.currentTickIndex,
          poolInfo.tickSpacing,
          preserveWidth,
        ));
      }

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

        // Swap tokens to the correct ratio for the new position if needed.
        // This implements the "swap tokens if ratio incorrect" step described in the
        // rebalancing loop: when an out-of-range position is closed we often receive
        // only one token, but the new in-range position requires both.
        closedPositionAmounts = await this.swapTokensIfNeeded(
          closedPositionAmounts.amountA,
          closedPositionAmounts.amountB,
          poolInfo,
          lower,
          upper,
        );
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
          closedPositionAmounts?.amountA,
          closedPositionAmounts?.amountB,
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

  /** Normalise a coin type string for comparison (lowercased, leading zeros stripped). */
  private normalizeCoinType(ct: string): string {
    return ct.toLowerCase().replace(/^0x0+/, '0x');
  }

  /**
   * Swap tokens to the correct ratio before opening a new position.
   *
   * After removing liquidity from an out-of-range position we often receive
   * only one token (e.g. all token B when the price moved above the old upper
   * tick).  The new position is centred on the current price and therefore
   * needs both tokens.  This method detects the imbalance and performs a
   * single swap transaction to correct it:
   *
   *   • New position below current price: needs only token A → swap all B→A.
   *   • New position above current price: needs only token B → swap all A→B.
   *   • New position in range with only one token: swap half to get both.
   *   • Already have the correct tokens: no swap.
   *
   * Returns the updated token amounts after the swap (or the original amounts
   * if no swap was needed).
   */
  private async swapTokensIfNeeded(
    amountA: string,
    amountB: string,
    poolInfo: PoolInfo,
    tickLower: number,
    tickUpper: number,
  ): Promise<{ amountA: string; amountB: string }> {
    const bigA = BigInt(amountA || '0');
    const bigB = BigInt(amountB || '0');

    if (bigA === 0n && bigB === 0n) {
      logger.debug('No freed tokens — skipping pre-swap step');
      return { amountA, amountB };
    }

    // Both tokens already available — the SDK zap-in will handle the ratio
    // adjustment internally, so no explicit swap is required here.
    if (bigA > 0n && bigB > 0n) {
      logger.info('Both tokens available after removing liquidity — no pre-swap needed');
      return { amountA, amountB };
    }

    // Determine current tick position relative to the new range.
    const currentTick = poolInfo.currentTickIndex;
    const priceIsBelowRange = currentTick < tickLower;
    const priceIsAboveRange = currentTick >= tickUpper;

    let a2b = false;         // true = sell token A for token B, false = sell token B for token A
    let swapAmount = 0n;

    if (priceIsBelowRange) {
      if (bigA === 0n && bigB > 0n) {
        // New position is below current price (needs only token A) but we only
        // have token B — swap all of token B to token A.
        a2b = false;
        swapAmount = bigB;
      } else {
        logger.info('Below-range position: already have token A — no swap needed');
        return { amountA, amountB };
      }
    } else if (priceIsAboveRange) {
      if (bigB === 0n && bigA > 0n) {
        // New position is above current price (needs only token B) but we only
        // have token A — swap all of token A to token B.
        a2b = true;
        swapAmount = bigA;
      } else {
        logger.info('Above-range position: already have token B — no swap needed');
        return { amountA, amountB };
      }
    } else {
      // New position is in range and needs both tokens but we only have one.
      // Swap approximately half to obtain both.
      if (bigA > 0n && bigB === 0n) {
        a2b = true;       // sell half of A for B
        swapAmount = bigA / 2n;
      } else {
        a2b = false;      // sell half of B for A
        swapAmount = bigB / 2n;
      }
      if (swapAmount === 0n) {
        logger.info('Pre-swap amount rounds to zero — skipping swap');
        return { amountA, amountB };
      }
    }

    logger.info('Swapping tokens to correct ratio before opening new position', {
      direction: a2b ? 'A→B' : 'B→A',
      swapAmount: swapAmount.toString(),
      currentA: bigA.toString(),
      currentB: bigB.toString(),
      priceIsBelowRange,
      priceIsAboveRange,
    });

    if (this.dryRun) {
      logger.info('[DRY RUN] Would swap tokens', {
        direction: a2b ? 'A→B' : 'B→A',
        swapAmount: swapAmount.toString(),
      });
      return { amountA, amountB };
    }

    const sdk = this.sdkService.getSdk();
    const keypair = this.sdkService.getKeypair();
    const suiClient = this.sdkService.getSuiClient();
    const ownerAddress = this.sdkService.getAddress();

    // Estimate minimum output using current sqrt price with slippage tolerance.
    // price_B_per_A = (sqrtPrice / 2^64)^2 = sqrtPrice^2 / 2^128
    const sqrtPriceBig = BigInt(new BN(poolInfo.currentSqrtPrice).toString());
    const TWO_128 = 2n ** 128n;
    const priceX128 = sqrtPriceBig * sqrtPriceBig;
    const slippageFactor = BigInt(Math.floor((1 - this.config.maxSlippage) * 10000));

    let minOutput: bigint;
    if (a2b) {
      const rawOut = priceX128 > 0n ? swapAmount * priceX128 / TWO_128 : 0n;
      minOutput = rawOut * slippageFactor / 10000n;
    } else {
      const rawOut = priceX128 > 0n ? swapAmount * TWO_128 / priceX128 : 0n;
      minOutput = rawOut * slippageFactor / 10000n;
    }

    const swapParams: SwapParams = {
      pool_id: poolInfo.poolAddress,
      a2b,
      by_amount_in: true,
      amount: swapAmount.toString(),
      amount_limit: minOutput.toString(),
      coinTypeA: poolInfo.coinTypeA,
      coinTypeB: poolInfo.coinTypeB,
    };
    const swapPayload = await sdk.Swap.createSwapTransactionPayload(swapParams);
    swapPayload.setGasBudget(this.config.gasBudget);

    const swapResult = await suiClient.signAndExecuteTransaction({
      transaction: swapPayload,
      signer: keypair,
      options: { showEffects: true, showBalanceChanges: true },
    });

    if (swapResult.effects?.status?.status !== 'success') {
      throw new Error(`Swap transaction failed: ${swapResult.effects?.status?.error || 'Unknown error'}`);
    }

    // Parse balance changes to determine the actual amounts received.
    const normalizedTypeA = this.normalizeCoinType(poolInfo.coinTypeA);
    const normalizedTypeB = this.normalizeCoinType(poolInfo.coinTypeB);
    const normalizedSuiType = this.normalizeCoinType('0x2::sui::SUI');

    const gasUsed = swapResult.effects?.gasUsed;
    const totalGasCost = gasUsed
      ? BigInt(gasUsed.computationCost) + BigInt(gasUsed.storageCost) - BigInt(gasUsed.storageRebate)
      : 0n;

    let deltaA = 0n;
    let deltaB = 0n;

    const balanceChanges: BalanceChange[] | null | undefined = swapResult.balanceChanges;
    if (balanceChanges) {
      for (const change of balanceChanges) {
        const owner = change.owner;
        if (typeof owner !== 'object' || !('AddressOwner' in owner)) continue;
        if ((owner as { AddressOwner: string }).AddressOwner.toLowerCase() !== ownerAddress.toLowerCase()) continue;
        let amt = BigInt(change.amount);
        const normalized = this.normalizeCoinType(change.coinType);
        // Recover gross SUI amount by adding back gas cost (mirrors removeLiquidity).
        if (amt < 0n && totalGasCost > 0n && normalized === normalizedSuiType) {
          const gross = amt + totalGasCost;
          amt = gross > 0n ? gross : 0n;
        }
        if (normalized === normalizedTypeA) deltaA += amt;
        else if (normalized === normalizedTypeB) deltaB += amt;
      }
    }

    const rawNewA = bigA + deltaA;
    const rawNewB = bigB + deltaB;
    const newAmountA = (rawNewA < 0n ? 0n : rawNewA).toString();
    const newAmountB = (rawNewB < 0n ? 0n : rawNewB).toString();

    logger.info('Pre-swap completed successfully', {
      digest: swapResult.digest,
      deltaA: deltaA.toString(),
      deltaB: deltaB.toString(),
      newAmountA,
      newAmountB,
    });

    return { amountA: newAmountA, amountB: newAmountB };
  }

  /**
   * Add liquidity using the Cetus SDK zap-in method with a single execution.
   *
   * When freed amounts from a closed position are provided they are used as
   * the zap input so the new position receives exactly the liquidity that was
   * released.  If no freed amounts are provided the method falls back to the
   * TOKEN_A_AMOUNT / TOKEN_B_AMOUNT environment variables.  Before invoking
   * the SDK the current pool tick is validated to be within [tickLower,
   * tickUpper); if the price is out of range the call is aborted immediately.
   * No retries are performed — any error (including MoveAbort code 0)
   * propagates to the caller without retrying.
   */
  private async addLiquidity(
    poolInfo: PoolInfo,
    tickLower: number,
    tickUpper: number,
    existingPositionId?: string,
    freedAmountA?: string,
    freedAmountB?: string,
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

      // Fetch current pool state and validate tick is within [tickLower, tickUpper).
      const pool = await sdk.Pool.getPool(poolInfo.poolAddress);
      const currentTickIndex = Number(pool.current_tick_index);

      if (currentTickIndex < tickLower || currentTickIndex >= tickUpper) {
        throw new Error(
          `Current tick ${currentTickIndex} is outside configured range [${tickLower}, ${tickUpper}] — aborting zap-in`,
        );
      }

      const currentSqrtPrice = new BN(pool.current_sqrt_price);
      const sqrtLowerPrice = TickMath.tickIndexToSqrtPriceX64(tickLower);
      const sqrtUpperPrice = TickMath.tickIndexToSqrtPriceX64(tickUpper);
      // TickMath is monotonic and we already aborted when currentTickIndex >= tickUpper,
      // so currentSqrtPrice remains below sqrtUpperPrice for the estimators below.

      logger.info('Current tick is within configured range', {
        currentTickIndex,
        tickLower,
        tickUpper,
      });

      // Determine single-sided zap input. Freed amounts from the closed position
      // take priority over env-var amounts. When both are absent, fall back to
      // env vars. The chosen side must be able to mint non-zero liquidity at the
      // current price.
      const envAmountA = this.config.tokenAAmount;
      const envAmountB = this.config.tokenBAmount;
      const zero = new BN(0);
      const quotes: QuoteSide[] = [];

      const hasFreedA = freedAmountA !== undefined && BigInt(freedAmountA) > 0n;
      const hasFreedB = freedAmountB !== undefined && BigInt(freedAmountB) > 0n;
      // Use the validated non-undefined values directly to avoid non-null assertions.
      const validFreedA = hasFreedA ? freedAmountA as string : undefined;
      const validFreedB = hasFreedB ? freedAmountB as string : undefined;

      if (hasFreedA || hasFreedB) {
        // Use freed amounts from the closed position to reopen with same liquidity.
        if (validFreedA) {
          const liqA = estimateLiquidityForCoinA(currentSqrtPrice, sqrtUpperPrice, new BN(validFreedA));
          quotes.push({ token: 'A', amount: validFreedA, liquidity: liqA });
        }
        if (validFreedB) {
          const liqB = estimateLiquidityForCoinB(sqrtLowerPrice, currentSqrtPrice, new BN(validFreedB));
          quotes.push({ token: 'B', amount: validFreedB, liquidity: liqB });
        }
      } else {
        // No freed amounts — use env-var configured amounts.
        if (envAmountA) {
          const liqA = estimateLiquidityForCoinA(currentSqrtPrice, sqrtUpperPrice, new BN(envAmountA));
          quotes.push({ token: 'A', amount: envAmountA, liquidity: liqA });
        }
        if (envAmountB) {
          const liqB = estimateLiquidityForCoinB(sqrtLowerPrice, currentSqrtPrice, new BN(envAmountB));
          quotes.push({ token: 'B', amount: envAmountB, liquidity: liqB });
        }
      }

      if (quotes.length === 0) {
        throw new Error('TOKEN_A_AMOUNT or TOKEN_B_AMOUNT must be configured for zap-in');
      }

      const viable = quotes.filter(q => q.liquidity.gt(zero));

      if (viable.length === 0) {
        logger.error('SDK zap-in quote predicts zero liquidity for configured token sides', {
          currentTickIndex,
          tickLower,
          tickUpper,
          quotes: quotes.map(q => ({
            token: q.token,
            amount: q.amount,
            predictedLiquidity: q.liquidity.toString(),
          })),
        });
        throw new Error('Zap-in quote returned zero liquidity for configured token sides');
      }

      // Preserve precedence: token A remains first when both sides are viable.
      const chosen = viable.find(q => q.token === 'A') || viable[0];
      let amountA: string;
      let amountB: string;

      if (chosen.token === 'A') {
        amountA = chosen.amount;
        amountB = '0';
        logger.info(`Using ${hasFreedA ? 'freed' : 'configured'} token A amount for zap-in`, {
          amountA,
          predictedLiquidity: chosen.liquidity.toString(),
        });
      } else {
        amountA = '0';
        amountB = chosen.amount;
        logger.info(`Using ${hasFreedB ? 'freed' : 'configured'} token B amount for zap-in`, {
          amountB,
          predictedLiquidity: chosen.liquidity.toString(),
        });
      }

      if (quotes.length > 1) {
        const otherToken = quotes.find(q => q.token !== chosen.token);
        // Only warn when the non-selected configured token would mint zero liquidity.
        if (otherToken && otherToken.liquidity.eq(zero)) {
          logger.warn(
            `${labelForToken(otherToken.token)} cannot mint liquidity at current tick - using ${labelForToken(chosen.token)} instead`,
          );
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
        fix_amount_a: BigInt(amountA) > 0n,
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

      const payload = await sdk.Position.createAddLiquidityFixTokenPayload(
        addLiquidityParams as any,
        { slippage: this.config.maxSlippage, curSqrtPrice: currentSqrtPrice },
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

      logger.info('Liquidity added successfully', {
        digest: result.digest,
        positionId: isOpen ? '(new position)' : positionId,
        amountA,
        amountB,
      });

      return { transactionDigest: result.digest };
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
