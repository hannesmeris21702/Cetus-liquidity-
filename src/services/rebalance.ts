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
  oldPosition?: { tickLower: number; tickUpper: number };
  newPosition?: { tickLower: number; tickUpper: number };
}

// SDK parameter types (avoids casting to `any` where possible)
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

export class RebalanceService {
  private sdkService: CetusSDKService;
  private monitorService: PositionMonitorService;
  private config: BotConfig;
  private dryRun: boolean;

  constructor(
    sdkService: CetusSDKService,
    monitorService: PositionMonitorService,
    config: BotConfig,
  ) {
    this.sdkService = sdkService;
    this.monitorService = monitorService;
    this.config = config;
    this.dryRun = process.env.DRY_RUN === 'true';

    if (this.dryRun) {
      logger.warn('⚠️  DRY RUN MODE — no transactions will be executed');
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Main entry point called every loop iteration.
   *
   * Step 4: fetch existing position by liquidity (highest liquidity position).
   * Step 5: check if position tick is inside [tickLower, tickUpper].
   * Step 6: if out of range → remove liquidity, swap tokens if needed, open new position.
   *
   * Returns null when position is in range (no action needed).
   */
  async checkAndRebalance(poolAddress: string): Promise<RebalanceResult | null> {
    try {
      const poolInfo = await this.monitorService.getPoolInfo(poolAddress);
      const ownerAddress = this.sdkService.getAddress();
      const allPositions = await this.monitorService.getPositions(ownerAddress);

      // Step 4: fetch existing position by liquidity — pick the one with most liquidity.
      const poolPositions = allPositions.filter(p => {
        if (p.poolAddress !== poolAddress) return false;
        try {
          return p.liquidity && BigInt(p.liquidity) > 0n;
        } catch {
          return false;
        }
      });

      if (poolPositions.length === 0) {
        logger.info('No positions with liquidity found in pool');
        return null;
      }

      // Highest liquidity position
      const position = [...poolPositions].sort((a, b) => {
        const lA = BigInt(a.liquidity || '0');
        const lB = BigInt(b.liquidity || '0');
        return lA > lB ? -1 : lA < lB ? 1 : 0;
      })[0];

      logger.info('Current position', {
        positionId: position.positionId,
        tickRange: `[${position.tickLower}, ${position.tickUpper}]`,
        currentTick: poolInfo.currentTickIndex,
        liquidity: position.liquidity,
      });

      // Step 5: check if position tick is inside LOWER_TICK and UPPER_TICK.
      const inRange = this.monitorService.isPositionInRange(
        position.tickLower,
        position.tickUpper,
        poolInfo.currentTickIndex,
      );

      if (inRange) {
        logger.info('Position is in range — no action needed');
        return null;
      }

      // Step 6: out of range → rebalance.
      logger.info('Position is OUT OF RANGE — starting rebalance', {
        positionId: position.positionId,
        tickRange: `[${position.tickLower}, ${position.tickUpper}]`,
        currentTick: poolInfo.currentTickIndex,
      });

      return this.rebalancePosition(position, poolInfo);
    } catch (error) {
      logger.error('checkAndRebalance failed', error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: rebalance flow
  // ---------------------------------------------------------------------------

  private async rebalancePosition(
    position: PositionInfo,
    poolInfo: PoolInfo,
  ): Promise<RebalanceResult> {
    try {
      // Determine new tick range.
      // Priority: explicit env vars → preserve old range width centred on current tick.
      let lower: number;
      let upper: number;

      if (this.config.lowerTick !== undefined && this.config.upperTick !== undefined) {
        lower = this.config.lowerTick;
        upper = this.config.upperTick;
        logger.info('Using env-configured tick range', { lower, upper });
      } else {
        // Preserve the width of the old position, centred on the current tick.
        // Both bounds are independently aligned to tickSpacing to ensure the
        // Cetus SDK accepts them as valid tick indices.
        const rangeWidth = position.tickUpper - position.tickLower;
        const tickSpacing = poolInfo.tickSpacing;
        const half = Math.floor(rangeWidth / 2);
        lower = Math.floor((poolInfo.currentTickIndex - half) / tickSpacing) * tickSpacing;
        upper = Math.ceil((poolInfo.currentTickIndex + half) / tickSpacing) * tickSpacing;
        logger.info('Calculated new tick range (preserving width)', { lower, upper, rangeWidth });
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

      // Remove liquidity from the out-of-range position.
      const freed = await this.removeLiquidity(position.positionId, position.liquidity, poolInfo);
      logger.info('Liquidity removed', { amountA: freed.amountA, amountB: freed.amountB });

      // Swap tokens to the correct ratio for the new range if needed.
      const adjusted = await this.swapTokensIfNeeded(
        freed.amountA,
        freed.amountB,
        poolInfo,
        lower,
        upper,
      );

      // Open new position with the adjusted amounts.
      const result = await this.addLiquidity(
        poolInfo,
        lower,
        upper,
        adjusted.amountA,
        adjusted.amountB,
      );

      logger.info('Rebalance completed', {
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

  // ---------------------------------------------------------------------------
  // Private: remove liquidity
  // ---------------------------------------------------------------------------

  private async removeLiquidity(
    positionId: string,
    liquidity: string,
    poolInfo: PoolInfo,
  ): Promise<{ amountA: string; amountB: string }> {
    logger.info('Removing liquidity', { positionId, liquidity });

    const sdk = this.sdkService.getSdk();
    const keypair = this.sdkService.getKeypair();
    const suiClient = this.sdkService.getSuiClient();
    const ownerAddress = this.sdkService.getAddress();

    // Snapshot pre-tx balances for fallback parsing.
    let coinTypeA = '';
    let coinTypeB = '';
    let preTxBalanceA = 0n;
    let preTxBalanceB = 0n;

    const result = await this.retryTransaction(
      async () => {
        // Re-fetch position to get fresh coin types on each retry.
        const positions = await this.monitorService.getPositions(ownerAddress);
        const pos = positions.find(p => p.positionId === positionId);
        if (!pos) throw new Error(`Position ${positionId} not found`);

        coinTypeA = pos.tokenA;
        coinTypeB = pos.tokenB;

        const [preBalA, preBalB] = await Promise.all([
          suiClient.getBalance({ owner: ownerAddress, coinType: coinTypeA }),
          suiClient.getBalance({ owner: ownerAddress, coinType: coinTypeB }),
        ]);
        preTxBalanceA = BigInt(preBalA.totalBalance);
        preTxBalanceB = BigInt(preBalB.totalBalance);

        const params: RemoveLiquidityParams = {
          pool_id: pos.poolAddress,
          pos_id: positionId,
          delta_liquidity: liquidity,
          min_amount_a: '0',
          min_amount_b: '0',
          coinTypeA: pos.tokenA,
          coinTypeB: pos.tokenB,
          collect_fee: true,
          rewarder_coin_types: [],
        };

        const payload = await sdk.Position.removeLiquidityTransactionPayload(params as any);
        payload.setGasBudget(this.config.gasBudget);

        const txResult = await suiClient.signAndExecuteTransaction({
          transaction: payload,
          signer: keypair,
          options: { showEffects: true, showEvents: true, showBalanceChanges: true },
        });

        if (txResult.effects?.status?.status !== 'success') {
          throw new Error(`Transaction failed: ${txResult.effects?.status?.error || 'Unknown'}`);
        }
        return txResult;
      },
      'remove liquidity',
      3,
      2000,
    );

    // Parse balance changes to determine freed token amounts.
    const normalizedTypeA = this.normalizeCoinType(coinTypeA);
    const normalizedTypeB = this.normalizeCoinType(coinTypeB);
    const normalizedSuiType = this.normalizeCoinType('0x2::sui::SUI');

    const gasUsed = result.effects?.gasUsed;
    const totalGasCost = gasUsed
      ? BigInt(gasUsed.computationCost) + BigInt(gasUsed.storageCost) - BigInt(gasUsed.storageRebate)
      : 0n;

    let amountA = '0';
    let amountB = '0';

    const balanceChanges: BalanceChange[] | null | undefined = result.balanceChanges;
    if (balanceChanges) {
      for (const change of balanceChanges) {
        const owner = change.owner;
        if (typeof owner !== 'object' || !('AddressOwner' in owner)) continue;
        if ((owner as { AddressOwner: string }).AddressOwner.toLowerCase() !== ownerAddress.toLowerCase()) continue;
        let amt = BigInt(change.amount);
        // Add back gas cost for SUI so the gross freed amount is recovered.
        if (amt < 0n && totalGasCost > 0n && this.normalizeCoinType(change.coinType) === normalizedSuiType) {
          const gross = amt + totalGasCost;
          amt = gross > 0n ? gross : 0n;
        }
        if (amt <= 0n) continue;
        const normalized = this.normalizeCoinType(change.coinType);
        if (normalized === normalizedTypeA) amountA = (BigInt(amountA) + amt).toString();
        else if (normalized === normalizedTypeB) amountB = (BigInt(amountB) + amt).toString();
      }
    }

    // Fallback: compare pre/post wallet balances when balance-change parsing gives zero.
    if (amountA === '0' && amountB === '0' && coinTypeA !== '') {
      logger.warn('Balance-change parsing yielded zero — using pre/post balance fallback');
      const [postBalA, postBalB] = await Promise.all([
        suiClient.getBalance({ owner: ownerAddress, coinType: coinTypeA }),
        suiClient.getBalance({ owner: ownerAddress, coinType: coinTypeB }),
      ]);
      const dA = BigInt(postBalA.totalBalance) - preTxBalanceA;
      const dB = BigInt(postBalB.totalBalance) - preTxBalanceB;
      if (dA > 0n) amountA = dA.toString();
      if (dB > 0n) amountB = dB.toString();
    }

    logger.info('Remove liquidity succeeded', { digest: result.digest, amountA, amountB });
    return { amountA, amountB };
  }

  // ---------------------------------------------------------------------------
  // Private: swap tokens to correct ratio
  // ---------------------------------------------------------------------------

  /**
   * Swap tokens to the correct ratio before opening the new position.
   *
   * After removing an out-of-range position we typically receive only one token.
   * This method corrects the imbalance:
   *   • new range below current price → need only A → swap all B→A
   *   • new range above current price → need only B → swap all A→B
   *   • new range in range with one token → swap half to get both
   *   • both tokens present → no swap needed (SDK zap-in handles the ratio)
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

    if (bigA === 0n && bigB === 0n) return { amountA, amountB };
    if (bigA > 0n && bigB > 0n) {
      logger.info('Both tokens available — no pre-swap needed');
      return { amountA, amountB };
    }

    const currentTick = poolInfo.currentTickIndex;
    const priceIsBelowRange = currentTick < tickLower;
    const priceIsAboveRange = currentTick >= tickUpper;

    let a2b = false;
    let swapAmount = 0n;

    if (priceIsBelowRange) {
      if (bigA === 0n && bigB > 0n) {
        a2b = false; swapAmount = bigB; // swap all B→A
      } else {
        return { amountA, amountB }; // already have A
      }
    } else if (priceIsAboveRange) {
      if (bigB === 0n && bigA > 0n) {
        a2b = true; swapAmount = bigA; // swap all A→B
      } else {
        return { amountA, amountB }; // already have B
      }
    } else {
      // In-range position needs both tokens — swap half of whichever we have.
      if (bigA > 0n) { a2b = true; swapAmount = bigA / 2n; }
      else { a2b = false; swapAmount = bigB / 2n; }
      if (swapAmount === 0n) return { amountA, amountB };
    }

    logger.info('Swapping tokens to correct ratio', {
      direction: a2b ? 'A→B' : 'B→A',
      swapAmount: swapAmount.toString(),
    });

    if (this.dryRun) {
      logger.info('[DRY RUN] Would swap tokens');
      return { amountA, amountB };
    }

    const sdk = this.sdkService.getSdk();
    const keypair = this.sdkService.getKeypair();
    const suiClient = this.sdkService.getSuiClient();
    const ownerAddress = this.sdkService.getAddress();

    // Estimate minimum output with slippage protection.
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
      throw new Error(`Swap failed: ${swapResult.effects?.status?.error || 'Unknown'}`);
    }

    // Parse balance changes to get actual post-swap amounts.
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

    logger.info('Swap completed', { digest: swapResult.digest, newAmountA, newAmountB });
    return { amountA: newAmountA, amountB: newAmountB };
  }

  // ---------------------------------------------------------------------------
  // Private: add liquidity (open new position)
  // ---------------------------------------------------------------------------

  /**
   * Open a new position using a single-sided zap-in.
   *
   * Freed token amounts take priority; falls back to TOKEN_A_AMOUNT / TOKEN_B_AMOUNT
   * env vars when no freed amounts are provided.
   */
  private async addLiquidity(
    poolInfo: PoolInfo,
    tickLower: number,
    tickUpper: number,
    freedAmountA?: string,
    freedAmountB?: string,
  ): Promise<{ transactionDigest?: string }> {
    logger.info('Adding liquidity', { poolAddress: poolInfo.poolAddress, tickLower, tickUpper });

    const sdk = this.sdkService.getSdk();
    const keypair = this.sdkService.getKeypair();
    const suiClient = this.sdkService.getSuiClient();

    // Refresh pool state and validate tick is in range.
    const pool = await sdk.Pool.getPool(poolInfo.poolAddress);
    const currentTickIndex = Number(pool.current_tick_index);

    if (currentTickIndex < tickLower || currentTickIndex >= tickUpper) {
      throw new Error(
        `Current tick ${currentTickIndex} is outside [${tickLower}, ${tickUpper}] — aborting zap-in`,
      );
    }

    const currentSqrtPrice = new BN(pool.current_sqrt_price);
    const sqrtLowerPrice = TickMath.tickIndexToSqrtPriceX64(tickLower);
    const sqrtUpperPrice = TickMath.tickIndexToSqrtPriceX64(tickUpper);
    const zero = new BN(0);

    // Build quote list from freed amounts or env-var amounts.
    type QuoteSide = { token: 'A' | 'B'; amount: string; liquidity: BN };
    const quotes: QuoteSide[] = [];

    const hasFreedA = freedAmountA !== undefined && BigInt(freedAmountA) > 0n;
    const hasFreedB = freedAmountB !== undefined && BigInt(freedAmountB) > 0n;
    const validFreedA = hasFreedA ? (freedAmountA as string) : undefined;
    const validFreedB = hasFreedB ? (freedAmountB as string) : undefined;

    if (hasFreedA || hasFreedB) {
      if (validFreedA) {
        quotes.push({ token: 'A', amount: validFreedA,
          liquidity: estimateLiquidityForCoinA(currentSqrtPrice, sqrtUpperPrice, new BN(validFreedA)) });
      }
      if (validFreedB) {
        quotes.push({ token: 'B', amount: validFreedB,
          liquidity: estimateLiquidityForCoinB(sqrtLowerPrice, currentSqrtPrice, new BN(validFreedB)) });
      }
    } else {
      const envA = this.config.tokenAAmount;
      const envB = this.config.tokenBAmount;
      if (envA) {
        quotes.push({ token: 'A', amount: envA,
          liquidity: estimateLiquidityForCoinA(currentSqrtPrice, sqrtUpperPrice, new BN(envA)) });
      }
      if (envB) {
        quotes.push({ token: 'B', amount: envB,
          liquidity: estimateLiquidityForCoinB(sqrtLowerPrice, currentSqrtPrice, new BN(envB)) });
      }
    }

    if (quotes.length === 0) {
      throw new Error('TOKEN_A_AMOUNT or TOKEN_B_AMOUNT must be set for zap-in');
    }

    const viable = quotes.filter(q => q.liquidity.gt(zero));
    if (viable.length === 0) {
      throw new Error('Zap-in quote returned zero liquidity for configured token amounts');
    }

    // Prefer token A when both sides are viable.
    const chosen = viable.find(q => q.token === 'A') || viable[0];
    const amountA = chosen.token === 'A' ? chosen.amount : '0';
    const amountB = chosen.token === 'B' ? chosen.amount : '0';

    logger.info('Zap-in token selected', {
      token: chosen.token,
      amount: chosen.amount,
      predictedLiquidity: chosen.liquidity.toString(),
    });

    const addLiquidityParams: AddLiquidityFixTokenParams = {
      pool_id: poolInfo.poolAddress,
      pos_id: '',
      tick_lower: String(tickLower),
      tick_upper: String(tickUpper),
      amount_a: amountA,
      amount_b: amountB,
      slippage: this.config.maxSlippage,
      fix_amount_a: BigInt(amountA) > 0n,
      is_open: true,
      coinTypeA: poolInfo.coinTypeA,
      coinTypeB: poolInfo.coinTypeB,
      collect_fee: false,
      rewarder_coin_types: [],
    };

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
      throw new Error(`Add liquidity failed: ${result.effects?.status?.error || 'Unknown'}`);
    }

    logger.info('New position opened', { digest: result.digest });
    return { transactionDigest: result.digest };
  }

  // ---------------------------------------------------------------------------
  // Private: retry helper
  // ---------------------------------------------------------------------------

  private async retryTransaction<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = 3,
    initialDelayMs: number = 2000,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = initialDelayMs * Math.pow(2, attempt - 1);
          logger.info(`Retry ${attempt + 1}/${maxRetries} for ${operationName} after ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        return await operation();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        lastError = error instanceof Error ? error : new Error(msg);

        const isRetryable =
          msg.includes('is not available for consumption') ||
          (msg.includes('Version') && msg.includes('Digest')) ||
          msg.includes('current version:') ||
          (msg.includes('pending') && msg.includes('seconds old')) ||
          (msg.includes('pending') && msg.includes('above threshold'));

        if (!isRetryable) throw error;

        if (attempt < maxRetries - 1) {
          logger.warn(`Retryable error in ${operationName} (attempt ${attempt + 1}/${maxRetries}): ${msg}`);
        } else {
          logger.error(`Max retries exceeded for ${operationName}`);
        }
      }
    }

    throw lastError || new Error(`All retries failed for ${operationName}`);
  }

  /** Normalise coin type for comparison (lowercased, leading zeros stripped). */
  private normalizeCoinType(ct: string): string {
    return ct.toLowerCase().replace(/^0x0+/, '0x');
  }
}
