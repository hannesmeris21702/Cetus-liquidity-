/**
 * Test for the in-retry recovery swap logic.
 *
 * When `createAddLiquidityFixTokenPayload` throws
 * "Insufficient balance for <coin>, expect <amount>" the bot should:
 *  1. Detect the error pattern and identify which token is missing.
 *  2. Perform a one-time recovery swap to obtain the missing token.
 *  3. Update addLiquidityParams with fresh amounts.
 *  4. Re-throw the original error so retryAddLiquidity retries with the
 *     updated amounts — succeeding on the next attempt.
 *
 * Run with: npx ts-node tests/insufficientBalanceSwapRecovery.test.ts
 */

import assert from 'assert';

// ---------------------------------------------------------------------------
// Helpers (mirroring logic from rebalance.ts)
// ---------------------------------------------------------------------------

function normalizeCoinType(ct: string): string {
  return ct.toLowerCase().replace(/^0x0+/, '0x');
}

/**
 * Parse "Insufficient balance for <coinType>, expect <amount>" errors emitted
 * by the Cetus TypeScript SDK when the wallet lacks the required counterpart token.
 */
function parseInsufficientBalanceError(errorMsg: string): { coinType: string; amount: bigint } | null {
  const match = errorMsg.match(/Insufficient balance for ([^\s,]+)\s*,\s*expect\s+(\d+)/i);
  if (!match) return null;
  return { coinType: match[1], amount: BigInt(match[2]) };
}

/**
 * Determine swap direction when recovering from an insufficient balance error.
 *
 * @returns `true`  → swap tokenA → tokenB (need more of tokenB)
 *          `false` → swap tokenB → tokenA (need more of tokenA)
 *          `null`  → cannot recover (no source token available)
 */
function determineRecoverySwapDirection(
  neededCoinType: string,
  coinTypeA: string,
  coinTypeB: string,
  safeBalA: bigint,
  safeBalB: bigint,
): boolean | null {
  const normalizedNeeded = normalizeCoinType(neededCoinType);
  const normalizedA = normalizeCoinType(coinTypeA);
  const normalizedB = normalizeCoinType(coinTypeB);

  if (normalizedNeeded === normalizedB && safeBalA > 0n) {
    return true;   // swap A → B
  }
  if (normalizedNeeded === normalizedA && safeBalB > 0n) {
    return false;  // swap B → A
  }
  return null;     // cannot recover
}

/**
 * Simulate the retry callback with recovery swap logic, matching the
 * implementation added to addLiquidity in rebalance.ts.
 */
async function simulateRetryWithRecovery(
  coinTypeA: string,
  coinTypeB: string,
  initialAmountA: bigint,
  initialAmountB: bigint,
  mockSwapResult: { amountA: string; amountB: string },
  sdkErrorOnFirstAttempt: string,
): Promise<{ attempts: number; finalAmountA: string; finalAmountB: string; succeeded: boolean }> {
  let amountA = initialAmountA.toString();
  let amountB = initialAmountB.toString();
  let recoverySwapAttempted = false;
  let attempts = 0;

  // Simulate retryAddLiquidity (max 3 retries)
  for (let attempt = 1; attempt <= 3; attempt++) {
    attempts = attempt;
    try {
      // Simulate createAddLiquidityFixTokenPayload failing on first attempt
      if (attempt === 1) {
        throw new Error(sdkErrorOnFirstAttempt);
      }
      // After recovery swap, subsequent attempts succeed
      return { attempts, finalAmountA: amountA, finalAmountB: amountB, succeeded: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const insuffMatch = errMsg.match(/Insufficient balance for ([^\s,]+)\s*,\s*expect\s+(\d+)/i);

      if (insuffMatch && !recoverySwapAttempted) {
        recoverySwapAttempted = true;
        const neededCoinType = insuffMatch[1];

        const safeBalA = initialAmountA;
        const safeBalB = initialAmountB;
        const aToB = determineRecoverySwapDirection(neededCoinType, coinTypeA, coinTypeB, safeBalA, safeBalB);

        if (aToB !== null) {
          // Simulate performZapInSwap updating the amounts
          amountA = mockSwapResult.amountA;
          amountB = mockSwapResult.amountB;
        }
      }
      // Re-throw to trigger next retry attempt
      if (attempt === 3) {
        return { attempts, finalAmountA: amountA, finalAmountB: amountB, succeeded: false };
      }
    }
  }
  return { attempts, finalAmountA: amountA, finalAmountB: amountB, succeeded: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('Running insufficient balance swap recovery tests...\n');

  const COIN_A = '0x2::sui::SUI';
  const COIN_B = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

  // ─── Test 1: SDK error is detected and parsed correctly ───────────────────
  {
    const errorMsg =
      `The amount(0) is Insufficient balance for ${COIN_B} , expect 700000`;
    const parsed = parseInsufficientBalanceError(errorMsg);
    assert.ok(parsed, 'Should parse insufficient balance error');
    assert.strictEqual(
      normalizeCoinType(parsed!.coinType),
      normalizeCoinType(COIN_B),
      'Parsed coin type should match USDC',
    );
    assert.strictEqual(parsed!.amount, 700000n, 'Parsed expected amount should be 700000');
    console.log('✔ SDK insufficient-balance error is parsed correctly');
  }

  // ─── Test 2: Recovery swap direction — need tokenB, have tokenA ───────────
  {
    const direction = determineRecoverySwapDirection(COIN_B, COIN_A, COIN_B, 1_000_000_000n, 0n);
    assert.strictEqual(direction, true, 'Should swap A→B when tokenB is needed and tokenA is available');
    console.log('✔ Recovery swap direction: need tokenB → swap A→B');
  }

  // ─── Test 3: Recovery swap direction — need tokenA, have tokenB ───────────
  {
    const direction = determineRecoverySwapDirection(COIN_A, COIN_A, COIN_B, 0n, 700000n);
    assert.strictEqual(direction, false, 'Should swap B→A when tokenA is needed and tokenB is available');
    console.log('✔ Recovery swap direction: need tokenA → swap B→A');
  }

  // ─── Test 4: Recovery swap skipped when no source token ───────────────────
  {
    const direction = determineRecoverySwapDirection(COIN_B, COIN_A, COIN_B, 0n, 0n);
    assert.strictEqual(direction, null, 'Should return null when no source token is available');
    console.log('✔ Recovery swap skipped when wallet has neither token');
  }

  // ─── Test 5: Full retry flow — insufficient balance triggers swap, then succeeds ─
  {
    const sdkError = `The amount(0) is Insufficient balance for ${COIN_B} , expect 700000`;
    const mockSwap = { amountA: '500000000', amountB: '700000' };

    const result = await simulateRetryWithRecovery(
      COIN_A, COIN_B,
      /* initialA */ 1_000_000_000n,
      /* initialB */ 0n,
      mockSwap,
      sdkError,
    );

    assert.ok(result.succeeded, 'Should succeed on retry after recovery swap');
    assert.strictEqual(result.attempts, 2, 'Should succeed on attempt 2 (after recovery on attempt 1)');
    assert.strictEqual(result.finalAmountA, mockSwap.amountA, 'Amount A should reflect post-swap balance');
    assert.strictEqual(result.finalAmountB, mockSwap.amountB, 'Amount B should reflect post-swap balance');
    console.log('✔ Full flow: insufficient-balance error → recovery swap → retry succeeds');
  }

  // ─── Test 6: Recovery is only attempted once (flag prevents double swap) ──
  {
    let swapCallCount = 0;

    async function simulateWithSwapCount(
      sdkError: string,
    ): Promise<number> {
      let recoverySwapAttempted = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          throw new Error(sdkError);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const insuffMatch = errMsg.match(/Insufficient balance for ([^\s,]+)\s*,\s*expect\s+(\d+)/i);
          if (insuffMatch && !recoverySwapAttempted) {
            recoverySwapAttempted = true;
            swapCallCount++;
          }
          if (attempt === 3) break;
        }
      }
      return swapCallCount;
    }

    swapCallCount = 0;
    const count = await simulateWithSwapCount(
      `The amount(0) is Insufficient balance for ${COIN_B} , expect 700000`,
    );
    assert.strictEqual(count, 1, 'Recovery swap should be attempted exactly once');
    console.log('✔ Recovery swap is only attempted once (flag guards against double swap)');
  }

  // ─── Test 7: Non-insufficient-balance errors are not treated as recovery ──
  {
    const nonInsufficientErrors = [
      'MoveAbort(...): some abort',
      'Network timeout',
      'Invalid tick range',
      'Object version mismatch',
    ];

    for (const errMsg of nonInsufficientErrors) {
      const parsed = parseInsufficientBalanceError(errMsg);
      assert.strictEqual(parsed, null, `Should NOT parse "${errMsg.slice(0, 40)}" as insufficient balance`);
    }
    console.log('✔ Non-insufficient-balance errors are not treated as recovery triggers');
  }

  // ─── Test 8: Coin type normalisation for comparison ───────────────────────
  {
    const coinWithLeadingZeros = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
    const coinShort = '0x2::sui::SUI';
    assert.strictEqual(
      normalizeCoinType(coinWithLeadingZeros),
      normalizeCoinType(coinShort),
      'Coin type normalisation should strip leading zeros',
    );
    console.log('✔ Coin type normalisation handles leading zeros correctly');
  }

  console.log('\nAll insufficient balance swap recovery tests passed ✅');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
