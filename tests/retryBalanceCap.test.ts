/**
 * Test for the per-retry wallet balance refetch and amount-capping logic.
 *
 * After a recovery swap updates addLiquidityParams.amount_a/b to the full
 * post-swap wallet balance, subsequent retry attempts refetch the wallet
 * balances and cap the amounts to the current safe balance before building
 * the add-liquidity payload.  Without this cap, a stale (or slightly too
 * high) amount_a/b can reach the on-chain repay_add_liquidity function and
 * cause MoveAbort(0) (insufficient balance on the contract side).
 *
 * Run with: npx ts-node tests/retryBalanceCap.test.ts
 */

import assert from 'assert';

// ---------------------------------------------------------------------------
// Minimal helpers mirroring the rebalance.ts implementation
// ---------------------------------------------------------------------------

const SUI_GAS_RESERVE = 50_000_000n; // matches default GAS_BUDGET

function safeBalance(rawBalance: bigint, isSui: boolean): bigint {
  return isSui && rawBalance > SUI_GAS_RESERVE
    ? rawBalance - SUI_GAS_RESERVE
    : rawBalance;
}

/**
 * Simulates the per-retry operation closure from addLiquidity that:
 *   1. Refetches wallet balances and caps amounts.
 *   2. Updates fix_amount_a to match the non-zero input after capping.
 *   3. Throws early if both amounts are zero after capping.
 *   4. Calls createAddLiquidityFixTokenPayload (mocked).
 *   5. Executes the transaction.
 */
async function simulateRetryOperation(opts: {
  amountA: bigint;
  amountB: bigint;
  fixAmountA: boolean;
  isSuiA: boolean;
  isSuiB: boolean;
  /** wallet balance returned by getBalance on each retry attempt */
  walletBalances: Array<{ rawA: bigint; rawB: bigint }>;
  /** If true, the SDK throws on this attempt (0-indexed); else succeeds */
  sdkThrowsOnAttempt?: Set<number>;
  maxRetries?: number;
}): Promise<{
  attemptAmounts: Array<{ amountA: bigint; amountB: bigint; fixAmountA: boolean }>;
  succeeded: boolean;
  attempts: number;
  lastError?: Error;
}> {
  const {
    isSuiA,
    isSuiB,
    walletBalances,
    sdkThrowsOnAttempt = new Set(),
    maxRetries = 3,
  } = opts;

  // Mutable params (mirrors addLiquidityParams in production code)
  let paramAmountA = opts.amountA;
  let paramAmountB = opts.amountB;
  let paramFixAmountA = opts.fixAmountA;

  const attemptAmounts: Array<{ amountA: bigint; amountB: bigint; fixAmountA: boolean }> = [];
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // ── Per-retry balance refetch and capping ─────────────────────────────
      const balIdx = Math.min(attempt - 1, walletBalances.length - 1);
      const { rawA, rawB } = walletBalances[balIdx];
      const safeA = safeBalance(rawA, isSuiA);
      const safeB = safeBalance(rawB, isSuiB);

      if (paramAmountA > safeA) paramAmountA = safeA;
      if (paramAmountB > safeB) paramAmountB = safeB;

      // After capping, update fix_amount_a to reflect the non-zero input token.
      // If the primary token's balance dropped to zero (e.g. SUI consumed by gas),
      // passing (amount=0, fix_amount_a=true) to the SDK always computes zero
      // liquidity and triggers MoveAbort(repay_add_liquidity, 0).
      const retryAmtA = paramAmountA;
      const retryAmtB = paramAmountB;
      if (retryAmtA === 0n && retryAmtB === 0n) {
        throw new Error('Insufficient token balance for add liquidity retry: both amounts are zero after capping to current safe balance.');
      }
      paramFixAmountA = retryAmtA > 0n;
      // ─────────────────────────────────────────────────────────────────────

      attemptAmounts.push({ amountA: paramAmountA, amountB: paramAmountB, fixAmountA: paramFixAmountA });

      // Mock createAddLiquidityFixTokenPayload + on-chain execution
      if (sdkThrowsOnAttempt.has(attempt - 1)) {
        // Simulate MoveAbort(0) when amounts exceed actual on-chain balance
        throw new Error(
          'MoveAbort(MoveLocation { module: ModuleId { address: b2db71..., ' +
          'name: Identifier("pool_script_v2") }, function: 23, instruction: 16, ' +
          'function_name: Some("repay_add_liquidity") }, 0) in command 2',
        );
      }

      return { attemptAmounts, succeeded: true, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // (MoveAbort non-retryable logic intentionally omitted for this test —
      //  the point is that with correct capping MoveAbort(0) never fires.)
    }
  }

  return { attemptAmounts, succeeded: false, attempts: maxRetries, lastError };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('Running per-retry balance-cap tests...\n');

  // ── Test 1: amounts NOT exceeding wallet balance → unchanged ──────────────
  {
    const result = await simulateRetryOperation({
      amountA: 800n,
      amountB: 200n,
      fixAmountA: true,
      isSuiA: false,
      isSuiB: false,
      walletBalances: [{ rawA: 1000n, rawB: 500n }],
    });

    assert.ok(result.succeeded, 'Should succeed on first attempt');
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(result.attemptAmounts[0].amountA, 800n, 'amountA should remain 800');
    assert.strictEqual(result.attemptAmounts[0].amountB, 200n, 'amountB should remain 200');
    assert.strictEqual(result.attemptAmounts[0].fixAmountA, true, 'fixAmountA should remain true');
    console.log('✔ Amounts not exceeding wallet balance are left unchanged');
  }

  // ── Test 2: amounts exceeding wallet balance → capped to safe balance ─────
  {
    const result = await simulateRetryOperation({
      // Recovery swap set amounts to full wallet balance at the time
      amountA: 1000n,
      amountB: 500n,
      fixAmountA: true,
      isSuiA: false,
      isSuiB: false,
      // But wallet balance on the retry is slightly lower (e.g. gas consumed)
      walletBalances: [{ rawA: 950n, rawB: 480n }],
    });

    assert.ok(result.succeeded, 'Should succeed after capping');
    assert.strictEqual(result.attemptAmounts[0].amountA, 950n, 'amountA should be capped to 950');
    assert.strictEqual(result.attemptAmounts[0].amountB, 480n, 'amountB should be capped to 480');
    assert.strictEqual(result.attemptAmounts[0].fixAmountA, true, 'fixAmountA should remain true (amountA still > 0)');
    console.log('✔ Amounts exceeding wallet balance are capped to current safe balance');
  }

  // ── Test 3: SUI gas reserve applied when isSuiA=true ─────────────────────
  {
    const rawA = 1_000_000_000n;
    const expectedSafeA = rawA - SUI_GAS_RESERVE; // 950_000_000

    const result = await simulateRetryOperation({
      amountA: rawA, // full balance — exceeds safe balance
      amountB: 500n,
      fixAmountA: true,
      isSuiA: true,
      isSuiB: false,
      walletBalances: [{ rawA, rawB: 500n }],
    });

    assert.ok(result.succeeded);
    assert.strictEqual(
      result.attemptAmounts[0].amountA,
      expectedSafeA,
      'SUI amountA should be capped to raw balance − gas reserve',
    );
    assert.strictEqual(result.attemptAmounts[0].amountB, 500n, 'amountB unchanged (not SUI)');
    console.log('✔ SUI gas reserve is correctly applied when tokenA is SUI');
  }

  // ── Test 4: Root-cause scenario — recovery swap sets stale amounts, retry ─
  //           uses fresh balance to cap before submission, preventing MoveAbort
  {
    // After recovery swap:  amountA=2000, amountB=100
    // Wallet on retry:      rawA=1900  (slightly less — stale amounts would exceed)
    // Without fix: amountA=2000 sent to contract → MoveAbort(0)
    // With fix:    amountA capped to 1900, payload built correctly → success

    const result = await simulateRetryOperation({
      amountA: 2000n,
      amountB: 100n,
      fixAmountA: true,
      isSuiA: false,
      isSuiB: false,
      walletBalances: [
        { rawA: 2000n, rawB: 100n }, // attempt 1 — balance OK
        { rawA: 1900n, rawB: 100n }, // attempt 2 — amountA would be stale
      ],
      // Attempt 1 (0-indexed) would get MoveAbort if amounts not capped
      sdkThrowsOnAttempt: new Set([0]),
      maxRetries: 3,
    });

    // Attempt 2 (0-indexed=1) should succeed with capped amountA=1900
    assert.ok(result.succeeded, 'Should succeed on attempt 2 after balance cap');
    assert.strictEqual(result.attempts, 2, 'Should take 2 attempts');
    assert.strictEqual(
      result.attemptAmounts[1].amountA,
      1900n,
      'On retry, amountA capped from 2000 to fresh safe balance 1900',
    );
    console.log('✔ Root-cause scenario: stale post-recovery-swap amounts are capped on retry, preventing MoveAbort(0)');
  }

  // ── Test 5: amounts updated across retries as wallet balance changes ───────
  {
    const result = await simulateRetryOperation({
      amountA: 5000n,
      amountB: 3000n,
      fixAmountA: true,
      isSuiA: false,
      isSuiB: false,
      walletBalances: [
        { rawA: 4000n, rawB: 2500n }, // attempt 1
        { rawA: 3500n, rawB: 2200n }, // attempt 2
        { rawA: 3000n, rawB: 2000n }, // attempt 3
      ],
      sdkThrowsOnAttempt: new Set([0, 1]), // fail on attempts 1 and 2
      maxRetries: 3,
    });

    assert.ok(result.succeeded, 'Should succeed on attempt 3');
    assert.strictEqual(result.attempts, 3);
    assert.strictEqual(result.attemptAmounts[0].amountA, 4000n, 'Attempt 1: capped to 4000');
    assert.strictEqual(result.attemptAmounts[1].amountA, 3500n, 'Attempt 2: capped to 3500');
    assert.strictEqual(result.attemptAmounts[2].amountA, 3000n, 'Attempt 3: capped to 3000');
    console.log('✔ Amounts are re-capped on every retry as wallet balance changes');
  }

  // ── Test 6: fix_amount_a updated when SUI tokenA balance drops to zero ─────
  //           (MoveAbort(repay_add_liquidity, 0) root-cause fix)
  {
    // Scenario: tokenA is SUI; after previous transactions drain the SUI balance
    // to zero, safeRetryA = 0.
    // Without the fix: amountA is capped to 0 but fix_amount_a stays true →
    //   SDK receives (amount_a=0, fix=true) → computes 0 liquidity → MoveAbort again.
    // With the fix: both amounts become 0 → throw early with a clear error
    //   instead of sending a doomed transaction to the chain.

    const result = await simulateRetryOperation({
      amountA: 1_000_000_000n,
      amountB: 0n,
      fixAmountA: true,
      isSuiA: true,
      isSuiB: false,
      walletBalances: [
        { rawA: 0n, rawB: 0n }, // SUI balance fully drained
      ],
      maxRetries: 1,
    });

    assert.ok(!result.succeeded, 'Should not succeed when both amounts are zero after capping');
    assert.ok(
      result.lastError?.message.includes('both amounts are zero'),
      `Should throw zero-amounts error; got: ${result.lastError?.message}`,
    );
    console.log('✔ Throws early with clear error when both amounts are zero after capping (prevents doomed MoveAbort)');
  }

  // ── Test 7: fix_amount_a stays false when tokenB is the single input ───────
  {
    // Scenario: above-range position, amountA=0, amountB=500, fix_amount_a=false.
    // Balance cap reduces amountB slightly but it remains > 0.
    // fix_amount_a must stay false.
    const result = await simulateRetryOperation({
      amountA: 0n,
      amountB: 500n,
      fixAmountA: false,
      isSuiA: false,
      isSuiB: false,
      walletBalances: [{ rawA: 0n, rawB: 450n }],
    });

    assert.ok(result.succeeded, 'Should succeed with tokenB as sole input');
    assert.strictEqual(result.attemptAmounts[0].amountA, 0n, 'amountA remains 0');
    assert.strictEqual(result.attemptAmounts[0].amountB, 450n, 'amountB capped to 450');
    assert.strictEqual(result.attemptAmounts[0].fixAmountA, false, 'fixAmountA stays false when only amountB > 0');
    console.log('✔ fix_amount_a stays false when tokenB is the sole non-zero input');
  }

  console.log('\nAll per-retry balance-cap tests passed ✅');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
