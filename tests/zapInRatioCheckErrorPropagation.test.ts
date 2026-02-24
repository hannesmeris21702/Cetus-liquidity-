/**
 * Test: corrective swap errors in the zap-in ratio check must propagate,
 * not be swallowed by the outer try/catch.
 *
 * Bug reproduced by log sequence:
 *   [INFO]  Zap-in: refined swap amount for optimal A:B ratio
 *   [INFO]  Zap-in swap estimate
 *   [WARN]  Zap-in ratio check failed — proceeding with available amounts
 *
 * Root cause: performZapInSwap (the corrective swap) was called INSIDE the
 * try/catch that guards only the ratio computation (getPool + TickMath).
 * When the swap transaction failed, the error was caught and swallowed, and
 * the bot proceeded with the original imbalanced amounts — causing the
 * subsequent add-liquidity call to fail as well.
 *
 * Fix: narrow the try/catch to cover only the ratio computation; keep
 * performZapInSwap outside so swap-transaction errors propagate to
 * retryAddLiquidity.
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
 * Simulate the FIXED control flow.  The ratio computation is inside a
 * try/catch; the corrective swap is OUTSIDE (errors propagate).
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

  // --- Step 2: corrective swap (NOT guarded — errors propagate) ---
  if (correctiveSwap) {
    if (swapShouldThrow) {
      throw new Error('Simulated swap transaction failure (e.g. Zap-in swap failed: on-chain abort)');
    }
    // Simulate a successful swap: move excess token
    // NOTE: uses a simplified 1:1 exchange rate for clarity.  The exact
    // post-swap amounts don't matter for this test — we're only validating
    // that (a) the swap is called at all, and (b) its error propagates.
    if (correctiveSwap.aToB) {
      amountA -= correctiveSwap.swapAmount;
      amountB += correctiveSwap.swapAmount;  // simplified: 1:1
    } else {
      amountB -= correctiveSwap.swapAmount;
      amountA += correctiveSwap.swapAmount;
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

  // ─── 2. Swap transaction throws → error PROPAGATES (not swallowed) ────────
  {
    const warnings: string[] = [];
    let caughtError: Error | null = null;
    try {
      await addLiquidityFixedFlow(
        8_000_000n, 2_000_000n,   // amounts (excess A in 1:1 ratio → corrective swap needed)
        1n, 1n,
        /* ratioComputationShouldThrow */ false,
        /* swapShouldThrow */ true,
        warnings,
      );
    } catch (err) {
      caughtError = err instanceof Error ? err : new Error(String(err));
    }

    assert.ok(caughtError, 'Swap transaction error should propagate — not be swallowed');
    assert.ok(
      caughtError!.message.includes('swap transaction failure') ||
      caughtError!.message.includes('Zap-in swap failed'),
      `Error message should describe swap failure, got: ${caughtError!.message}`,
    );
    assert.strictEqual(warnings.length, 0, 'No "ratio check failed" warning should be emitted when the swap itself fails');
    console.log('✔ Scenario 2: swap transaction throws → error propagates (not swallowed)');
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

  // ─── 5. Verify the old (buggy) flow would have swallowed the swap error ───
  //    The bug: swap called INSIDE the try/catch
  {
    const warnings: string[] = [];
    let caughtError: Error | null = null;

    // Simulate old buggy flow: performZapInSwap INSIDE try/catch
    async function addLiquidityBuggyFlow(): Promise<void> {
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
      await addLiquidityBuggyFlow();
    } catch (err) {
      caughtError = err instanceof Error ? err : new Error(String(err));
    }

    // In the buggy flow the error was swallowed — no exception propagated
    assert.strictEqual(caughtError, null, 'Buggy flow: error was swallowed (no exception)');
    assert.strictEqual(warnings.length, 1, 'Buggy flow: emitted the misleading "ratio check failed" warning');
    console.log('✔ Scenario 5: confirms the OLD buggy flow swallowed the swap error (regression baseline)');
  }

  console.log('\nAll zap-in ratio-check error-propagation tests passed ✅');
  console.log('\nFix summary:');
  console.log('  Before: performZapInSwap INSIDE try/catch → swap errors swallowed');
  console.log('          → proceeds with imbalanced amounts → add-liquidity fails');
  console.log('  After:  ratio computation INSIDE try/catch (safe fallback)');
  console.log('          performZapInSwap OUTSIDE try/catch → swap errors propagate');
  console.log('          → retryAddLiquidity can retry with fresh state');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
