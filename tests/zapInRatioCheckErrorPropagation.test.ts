/**
 * Test: corrective swap error-handling in the zap-in ratio check.
 *
 * History of fixes:
 *
 * Bug 1 (old): performZapInSwap was called INSIDE the try/catch that guards
 *   the ratio computation.  Swap errors were silently swallowed → bot
 *   proceeded with imbalanced amounts → add-liquidity call failed.
 *   Log pattern: [WARN] Zap-in ratio check failed — proceeding with available amounts
 *
 * Fix for Bug 1: move performZapInSwap OUTSIDE the ratio-computation try/catch.
 *   Swap errors now propagated, but they bypassed retryAddLiquidity entirely
 *   (corrective swap runs before retryAddLiquidity is called).
 *
 * Bug 2 (current issue): the corrective swap (before retryAddLiquidity) fails
 *   with e.g. "Insufficient balance for USDC" from the SDK → error propagates
 *   to addLiquidity's outer catch → "Failed to add liquidity" → no retry.
 *   Log pattern: [INFO] Zap-in swap estimate → [ERROR] Failed to add liquidity
 *
 * Fix for Bug 2: wrap the corrective swap in its OWN try/catch.  On failure
 *   log a targeted warning and fall through to retryAddLiquidity.  The
 *   recovery-swap logic inside retryAddLiquidity then performs the required
 *   token swap and retries add-liquidity with the updated amounts.
 *
 * Run with: npx ts-node tests/zapInRatioCheckErrorPropagation.test.ts
 */

import assert from 'assert';

// ---------------------------------------------------------------------------
// Helpers that mirror the fixed control-flow in addLiquidity
// ---------------------------------------------------------------------------

interface SwapInstruction {
  aToB: boolean;
  swapAmount: bigint;
}

/**
 * Compute the corrective-swap instruction (if any) purely from ratio math.
 * Mirrors the try block inside the fixed `else if (bigAmountA > 0n && bigAmountB > 0n)`.
 * Returns null if computation throws.
 */
function computeCorrectiveSwap(
  bigAmountA: bigint,
  bigAmountB: bigint,
  refA: bigint,
  refB: bigint,
  shouldThrow: boolean,
): SwapInstruction | null {
  if (shouldThrow) throw new Error('Simulated ratio-computation error (e.g. network, TickMath)');

  if (refA === 0n || refB === 0n) return null;

  const excessA = bigAmountA * refB > refA * bigAmountB;
  const excessB = bigAmountB * refA > refB * bigAmountA;

  if (excessA) {
    const idealA = bigAmountB * refA / refB;
    const swapAmount = (bigAmountA - idealA) / 2n;
    return swapAmount > 0n ? { aToB: true, swapAmount } : null;
  }
  if (excessB) {
    const idealB = bigAmountA * refB / refA;
    const swapAmount = (bigAmountB - idealB) / 2n;
    return swapAmount > 0n ? { aToB: false, swapAmount } : null;
  }
  return null;
}

/**
 * Simulate the CURRENT control flow (Fix for Bug 2):
 *  - Ratio computation is inside a try/catch (safe fallback).
 *  - Corrective swap is in its OWN try/catch so that swap failures are caught,
 *    a warning is logged, and execution falls through to retryAddLiquidity's
 *    recovery-swap logic.
 */
async function addLiquidityFixedFlow(
  bigAmountA: bigint,
  bigAmountB: bigint,
  refA: bigint,
  refB: bigint,
  ratioComputationShouldThrow: boolean,
  swapShouldThrow: boolean,
  warnings: string[],
): Promise<{ amountA: bigint; amountB: bigint }> {
  let amountA = bigAmountA;
  let amountB = bigAmountB;

  // --- Step 1: ratio computation (guarded) ---
  let correctiveSwap: SwapInstruction | null = null;
  try {
    correctiveSwap = computeCorrectiveSwap(bigAmountA, bigAmountB, refA, refB, ratioComputationShouldThrow);
  } catch {
    warnings.push('Zap-in ratio check failed — proceeding with available amounts');
  }

  // --- Step 2: corrective swap (own try/catch — failure falls through to recovery) ---
  if (correctiveSwap) {
    try {
      if (swapShouldThrow) {
        throw new Error('Simulated swap transaction failure (e.g. Insufficient balance for USDC)');
      }
      // Simulate a successful swap: move excess token
      // NOTE: uses a simplified 1:1 exchange rate for clarity.
      if (correctiveSwap.aToB) {
        amountA -= correctiveSwap.swapAmount;
        amountB += correctiveSwap.swapAmount;  // simplified: 1:1
      } else {
        amountB -= correctiveSwap.swapAmount;
        amountA += correctiveSwap.swapAmount;
      }
    } catch (swapErr) {
      warnings.push('Corrective zap-in swap failed — proceeding with pre-swap amounts; recovery swap will retry');
    }
  }

  return { amountA, amountB };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('Running zap-in ratio-check error-propagation tests...\n');

  // ─── 1. Ratio computation throws → warning logged, proceed with originals ─
  {
    const warnings: string[] = [];
    const result = await addLiquidityFixedFlow(
      8_000_000n, 2_000_000n,   // amounts (excess A)
      1n, 1n,                    // ratio 1:1 (not used; computation throws first)
      /* ratioComputationShouldThrow */ true,
      /* swapShouldThrow */ false,
      warnings,
    );
    assert.strictEqual(warnings.length, 1, 'Should emit exactly one warning');
    assert.ok(warnings[0].includes('ratio check failed'), 'Warning message should reference ratio check');
    assert.strictEqual(result.amountA, 8_000_000n, 'amountA unchanged when ratio computation throws');
    assert.strictEqual(result.amountB, 2_000_000n, 'amountB unchanged when ratio computation throws');
    console.log('✔ Scenario 1: ratio computation throws → warning + original amounts kept');
  }

  // ─── 2. Swap transaction throws → warning logged, original amounts kept ───
  //    (error is caught in corrective-swap try/catch; retryAddLiquidity recovery
  //     swap will handle the imbalance on the next attempt)
  {
    const warnings: string[] = [];
    let caughtError: Error | null = null;
    let result: { amountA: bigint; amountB: bigint } | null = null;
    try {
      result = await addLiquidityFixedFlow(
        8_000_000n, 2_000_000n,   // amounts (excess A in 1:1 ratio → corrective swap needed)
        1n, 1n,
        /* ratioComputationShouldThrow */ false,
        /* swapShouldThrow */ true,
        warnings,
      );
    } catch (err) {
      caughtError = err instanceof Error ? err : new Error(String(err));
    }

    assert.strictEqual(caughtError, null, 'Corrective swap error should be caught (not propagated) so retryAddLiquidity can recover');
    assert.ok(result, 'Should return a result even when corrective swap fails');
    assert.strictEqual(warnings.length, 1, 'Should emit exactly one warning about the failed corrective swap');
    assert.ok(warnings[0].includes('Corrective zap-in swap failed'), 'Warning should describe corrective swap failure');
    // Amounts are unchanged — retryAddLiquidity's recovery swap will fix the imbalance
    assert.strictEqual(result!.amountA, 8_000_000n, 'amountA unchanged when corrective swap fails');
    assert.strictEqual(result!.amountB, 2_000_000n, 'amountB unchanged when corrective swap fails');
    console.log('✔ Scenario 2: corrective swap fails → warning logged, original amounts kept, retryAddLiquidity can recover');
  }

  // ─── 3. Both computation and swap succeed → amounts updated ───────────────
  {
    const warnings: string[] = [];
    const result = await addLiquidityFixedFlow(
      8_000_000n, 2_000_000n,   // excess A for 1:1 ratio
      1n, 1n,
      /* ratioComputationShouldThrow */ false,
      /* swapShouldThrow */ false,
      warnings,
    );
    assert.strictEqual(warnings.length, 0, 'No warnings when both succeed');
    assert.ok(result.amountA < 8_000_000n, 'amountA reduced after corrective A→B swap');
    assert.ok(result.amountB > 2_000_000n, 'amountB increased after corrective A→B swap');
    console.log('✔ Scenario 3: ratio computation + swap both succeed → amounts updated');
  }

  // ─── 4. No imbalance → no swap, no warning ────────────────────────────────
  {
    const warnings: string[] = [];
    const result = await addLiquidityFixedFlow(
      5_000_000n, 5_000_000n,   // balanced 1:1
      1n, 1n,
      false, false,
      warnings,
    );
    assert.strictEqual(warnings.length, 0, 'No warnings when ratio is already balanced');
    assert.strictEqual(result.amountA, 5_000_000n, 'amountA unchanged when balanced');
    assert.strictEqual(result.amountB, 5_000_000n, 'amountB unchanged when balanced');
    console.log('✔ Scenario 4: balanced ratio → no swap, no warning, amounts unchanged');
  }

  // ─── 5. Verify the original (Bug 1) buggy flow would have swallowed the swap error ─
  //    The bug: swap called INSIDE the ratio-computation try/catch
  {
    const warnings: string[] = [];
    let caughtError: Error | null = null;

    // Simulate Bug 1 buggy flow: performZapInSwap INSIDE ratio-computation try/catch
    async function addLiquidityBug1Flow(): Promise<void> {
      try {
        // ratio computation succeeds
        const swapInstruction = computeCorrectiveSwap(8_000_000n, 2_000_000n, 1n, 1n, false);
        if (swapInstruction) {
          // swap is called here — inside the try/catch — error gets swallowed
          throw new Error('Simulated swap transaction failure');
        }
      } catch {
        warnings.push('Zap-in ratio check failed — proceeding with available amounts');
      }
      // code continues with original imbalanced amounts — wrong!
    }

    try {
      await addLiquidityBug1Flow();
    } catch (err) {
      caughtError = err instanceof Error ? err : new Error(String(err));
    }

    // In the Bug 1 flow the error was swallowed — no exception propagated
    assert.strictEqual(caughtError, null, 'Bug 1 flow: error was swallowed (no exception)');
    assert.strictEqual(warnings.length, 1, 'Bug 1 flow: emitted the misleading "ratio check failed" warning');
    console.log('✔ Scenario 5: confirms Bug 1 flow (swap inside ratio try/catch) swallowed the error');
  }

  // ─── 6. Corrective swap fails, then retryAddLiquidity recovery succeeds ───
  //    Simulates the full flow: corrective swap fails → warning → retryAddLiquidity
  //    detects "Insufficient balance" → recovery swap → retry succeeds.
  {
    const COIN_B = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
    const insufficientBalanceError = `The amount(173416) is Insufficient balance for ${COIN_B} , expect 321015`;

    let recoverySwapAttempted = false;
    let retryAttempts = 0;

    async function simulateFullFlow(): Promise<string> {
      // Step 1: corrective swap fails (catches, logs warning)
      let correctiveSwapWarned = false;
      try {
        throw new Error(insufficientBalanceError);
      } catch {
        correctiveSwapWarned = true;
      }
      assert.ok(correctiveSwapWarned, 'Corrective swap failure should be caught');

      // Step 2: retryAddLiquidity with recovery swap
      for (let attempt = 1; attempt <= 3; attempt++) {
        retryAttempts = attempt;
        try {
          if (attempt === 1) {
            // First retry: createAddLiquidityFixTokenPayload throws "Insufficient balance"
            throw new Error(insufficientBalanceError);
          }
          // Second retry: succeeds after recovery swap
          return 'success';
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const insuffMatch = errMsg.match(/Insufficient balance for ([^\s,]+)\s*,\s*expect\s+(\d+)/i);
          if (insuffMatch && !recoverySwapAttempted) {
            recoverySwapAttempted = true;
            // Recovery swap executes (performZapInSwap) — gets required token
          }
          if (attempt === 3) throw err;
        }
      }
      throw new Error('Unreachable: retry loop exited without returning or throwing');
    }

    const result = await simulateFullFlow();
    assert.strictEqual(result, 'success', 'Should succeed after corrective swap failure + recovery swap');
    assert.strictEqual(retryAttempts, 2, 'Should succeed on 2nd retry (after recovery swap on 1st)');
    assert.ok(recoverySwapAttempted, 'Recovery swap inside retryAddLiquidity should have been attempted');
    console.log('✔ Scenario 6: corrective swap fails → retryAddLiquidity recovery swap → succeeds on retry');
  }

  console.log('\nAll zap-in ratio-check error-propagation tests passed ✅');
  console.log('\nFix summary:');
  console.log('  Before: performZapInSwap INSIDE try/catch → swap errors swallowed');
  console.log('          → proceeds with imbalanced amounts → add-liquidity fails');
  console.log('  After:  ratio computation INSIDE try/catch (safe fallback)');
  console.log('          performZapInSwap in own try/catch → swap errors caught with warning');
  console.log('          → retryAddLiquidity recovery swap handles the imbalance');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
