import { CetusSDKService } from './sdk';
import { PositionMonitorService, PoolInfo, PositionInfo } from './monitor';
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

      if (hasLiquidity) {
        // Remove liquidity from old position. The zap-based addLiquidity will
        // use whatever tokens are available in the wallet after removal.
        await this.removeLiquidity(position.positionId, position.liquidity);
        logger.info('Successfully removed liquidity from old position', {
          positionId: position.positionId,
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
      // The zap method uses available wallet balances directly — no pre-swaps needed.
      let result;
      try {
        result = await this.addLiquidity(
          poolInfo,
          lower,
          upper,
          existingInRangePosition?.positionId,
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
   * Add liquidity using the SDK's fix-token (zap) method.
   *
   * This method provides available wallet balances directly to
   * createAddLiquidityFixTokenPayload and lets the SDK compute the correct
   * proportional amounts — no manual pre-swaps are required:
   *
   *  - Position below range  → only token A needed; amount_b = 0
   *  - Position above range  → only token B needed; amount_a = 0
   *  - Position in range     → provide both tokens; SDK calculates ratio from the fixed token
   */
  private async addLiquidity(
    poolInfo: PoolInfo,
    tickLower: number,
    tickUpper: number,
    existingPositionId?: string,
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
        throw new Error('No tokens available to add liquidity. Please ensure wallet has sufficient balance.');
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

      // Zap method: provide the token(s) that the position range actually needs.
      // The SDK calculates the exact proportional amounts from the fixed token.
      let amountA: string;
      let amountB: string;

      if (priceIsBelowRange) {
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
