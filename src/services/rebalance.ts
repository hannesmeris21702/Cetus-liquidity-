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

      // Calculate the tightest active range (single tick-spacing bin) centred
      // on the current tick.  This maximises capital efficiency and fee capture.
      const { lower, upper } = this.monitorService.calculateOptimalRange(
        poolInfo.currentTickIndex,
        poolInfo.tickSpacing,
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
        2,
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

    const result = await suiClient.signAndExecuteTransaction({
      transaction: swapPayload,
      signer: keypair,
      options: { showEffects: true },
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

      // Reserve gas when a token is SUI so the add-liquidity transaction
      // does not try to spend the entire balance and fail with balance::split.
      const SUI_GAS_RESERVE = BigInt(this.config.gasBudget); // e.g. 0.1 SUI
      const SUI_TYPE = '0x2::sui::SUI';
      const SUI_TYPE_FULL = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
      const isSuiCoinType = (ct: string) => ct === SUI_TYPE || ct === SUI_TYPE_FULL;
      const isSuiA = isSuiCoinType(poolInfo.coinTypeA);
      const isSuiB = isSuiCoinType(poolInfo.coinTypeB);
      const safeBalanceA = isSuiA && balanceABigInt > SUI_GAS_RESERVE
        ? balanceABigInt - SUI_GAS_RESERVE
        : balanceABigInt;
      const safeBalanceB = isSuiB && balanceBBigInt > SUI_GAS_RESERVE
        ? balanceBBigInt - SUI_GAS_RESERVE
        : balanceBBigInt;
      
      let amountA: string;
      let amountB: string;
      
      if (removedAmountA || removedAmountB) {
        // Rebalancing: use the token amounts freed from the old position.
        // For out-of-range positions, one token's freed amount may be 0/undefined.
        // Fall back to the safe wallet balance (minus gas reserve for SUI) so
        // the SDK can pull the required counterpart amount when adding to an
        // in-range position.
        // Cap at safe balance to handle gas-cost deductions (e.g. when one of
        // the tokens is SUI, removal gas reduces the balance delta).
        const removedA = removedAmountA ? BigInt(removedAmountA) : 0n;
        const removedB = removedAmountB ? BigInt(removedAmountB) : 0n;
        amountA = (removedA > 0n && removedA <= safeBalanceA ? removedA : safeBalanceA).toString();
        amountB = (removedB > 0n && removedB <= safeBalanceB ? removedB : safeBalanceB).toString();
        logger.info('Using removed position amounts for rebalance', { amountA, amountB });
      } else {
        amountA = this.config.tokenAAmount || String(safeBalanceA > 0n ? safeBalanceA / 10n : defaultMinAmount);
        amountB = this.config.tokenBAmount || String(safeBalanceB > 0n ? safeBalanceB / 10n : defaultMinAmount);
      }

      // When one token has zero balance (common after removing an out-of-range
      // position that was fully single-sided), swap approximately half of the
      // available token so that both tokens are non-zero.  An in-range position
      // requires non-zero amounts of both tokens; without this step the Cetus
      // Move contract aborts with error 0 in repay_add_liquidity.
      {
        const preSwapA = BigInt(amountA);
        const preSwapB = BigInt(amountB);
        const oneIsZero =
          (preSwapA === 0n && preSwapB > 0n) ||
          (preSwapA > 0n && preSwapB === 0n);

        if (oneIsZero) {
          const hasOnlyA = preSwapA > 0n;
          const swapAmount = (hasOnlyA ? preSwapA : preSwapB) / 2n;

          if (swapAmount > 0n) {
            logger.info(
              'One token has zero balance - swapping to obtain both tokens',
              { direction: hasOnlyA ? 'A→B' : 'B→A', swapAmount: swapAmount.toString() },
            );

            try {
              await this.performSwap(poolInfo, hasOnlyA, swapAmount.toString());

              // Re-fetch wallet balances after swap
              const postSwapBalA = await suiClient.getBalance({
                owner: ownerAddress,
                coinType: poolInfo.coinTypeA,
              });
              const postSwapBalB = await suiClient.getBalance({
                owner: ownerAddress,
                coinType: poolInfo.coinTypeB,
              });

              const postBigA = BigInt(postSwapBalA.totalBalance);
              const postBigB = BigInt(postSwapBalB.totalBalance);
              const newSafeA =
                isSuiA && postBigA > SUI_GAS_RESERVE
                  ? postBigA - SUI_GAS_RESERVE
                  : postBigA;
              const newSafeB =
                isSuiB && postBigB > SUI_GAS_RESERVE
                  ? postBigB - SUI_GAS_RESERVE
                  : postBigB;

              amountA = (newSafeA > 0n ? newSafeA : 0n).toString();
              amountB = (newSafeB > 0n ? newSafeB : 0n).toString();

              logger.info('Balances after swap', { amountA, amountB });
            } catch (swapError) {
              const swapMsg = swapError instanceof Error ? swapError.message : String(swapError);
              logger.warn(
                `Swap failed (${swapMsg}) - will attempt add liquidity with available amounts`,
              );
            }
          }
        }
      }

      // Validate amounts
      try {
        const amountABigInt = BigInt(amountA);
        const amountBBigInt = BigInt(amountB);
        
        if (removedAmountA || removedAmountB) {
          // During rebalance, an out-of-range position may have all value in one token.
          // After falling back to wallet balance, both should be non-zero if possible.
          if (amountABigInt === 0n && amountBBigInt === 0n) {
            throw new Error('No tokens available for rebalancing. Wallet has insufficient balance of both tokens.');
          }
          if (amountABigInt === 0n || amountBBigInt === 0n) {
            logger.warn('One token still has zero balance after swap attempt. ' +
              'The add liquidity transaction will likely fail. Consider manually providing both tokens.');
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
      const addLiquidityParams: AddLiquidityFixTokenParams = {
        pool_id: poolInfo.poolAddress,
        pos_id: positionId,
        tick_lower: tickLower,
        tick_upper: tickUpper,
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
        2,
        2000
      );
      
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
      const poolPositions = allPositions.filter(p => p.poolAddress === poolAddress);

      if (poolPositions.length === 0) {
        logger.info('No existing positions found in pool - will create new position');
        return await this.rebalancePosition(poolAddress);
      }

      // Check each position: in-range positions are left untouched, out-of-range
      // positions are candidates for rebalancing.
      const inRangePositions: PositionInfo[] = [];
      const outOfRangePositions: PositionInfo[] = [];

      for (const pos of poolPositions) {
        const isInRange = this.monitorService.isPositionInRange(
          pos.tickLower,
          pos.tickUpper,
          poolInfo.currentTickIndex,
        );

        if (isInRange) {
          logger.info(
            `Position ${pos.positionId} is in range [${pos.tickLower}, ${pos.tickUpper}] ` +
            `at tick ${poolInfo.currentTickIndex} — no action needed`,
          );
          inRangePositions.push(pos);
        } else {
          logger.info(
            `Position ${pos.positionId} is OUT of range [${pos.tickLower}, ${pos.tickUpper}] ` +
            `at tick ${poolInfo.currentTickIndex} — rebalance needed`,
          );
          outOfRangePositions.push(pos);
        }
      }

      if (outOfRangePositions.length === 0) {
        logger.info('All positions are in range — no rebalance needed');
        return null;
      }

      logger.info(
        `${outOfRangePositions.length} out-of-range position(s) and ` +
        `${inRangePositions.length} in-range position(s) — proceeding with rebalance`,
      );

      // Rebalance: create new position with same parameters at new active range
      // or rebalance existing position to the new active range.
      return await this.rebalancePosition(poolAddress);
    } catch (error) {
      logger.error('Check and rebalance failed', error);
      throw error;
    }
  }
}
