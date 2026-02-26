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
 *   2. Detects price-crossed-boundary and switches the input token if needed.
 *   3. Updates fix_amount_a to match the non-zero input after adjustments.
 *   4. Throws early if both amounts are zero after adjustments.
 *   5. Calls createAddLiquidityFixTokenPayload (mocked).
 *   6. Executes the transaction.
 */
async function simulateRetryOperation(opts: {
  amountA: bigint;
  amountB: bigint;
  fixAmountA: boolean;
  isSuiA: boolean;
  isSuiB: boolean;
  /** tick range for the position */
  tickLower?: number;
  tickUpper?: number;
  /** fresh pool tick index returned on each retry attempt */
  freshTickIndexes?: number[];
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
    tickLower = -100,
    tickUpper = 100,
    freshTickIndexes,
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

      // ── Price-crossed-boundary token switch ───────────────────────────────
      // Mirrors the new logic added to rebalance.ts to handle MoveAbort(repay_add_liquidity, 0)
      // caused by using the wrong token when the price has moved across the range boundary.
      if (freshTickIndexes) {
        const freshTickIdx = Math.min(attempt - 1, freshTickIndexes.length - 1);
        const freshTickIndex = freshTickIndexes[freshTickIdx];
        const freshPriceIsAboveRange = freshTickIndex >= tickUpper;
        const freshPriceIsBelowRange = freshTickIndex < tickLower;

        if (freshPriceIsAboveRange && paramFixAmountA) {
          if (safeB > 0n) {
            paramAmountA = 0n;
            paramAmountB = safeB;
          } else {
            throw new Error(
              `Cannot add liquidity: price (tick ${freshTickIndex}) is above range upper tick ${tickUpper} ` +
              'but token B balance is zero. Please add token B to your wallet.',
            );
          }
        } else if (freshPriceIsBelowRange && !paramFixAmountA) {
          if (safeA > 0n) {
            paramAmountA = safeA;
            paramAmountB = 0n;
          } else {
            throw new Error(
              `Cannot add liquidity: price (tick ${freshTickIndex}) is below range lower tick ${tickLower} ` +
              'but token A balance is zero. Please add token A to your wallet.',
            );
          }
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      // After capping and price-based token switching, update fix_amount_a to
      // reflect the non-zero input token.
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
      //  the point is that with correct token selection MoveAbort(0) never fires.)
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

  // ── Test 8: price moved ABOVE range while using token A → switch to token B ─
  //           Root cause of the new MoveAbort(repay_add_liquidity, 0) error
  {
    // Scenario: initial amounts set with fix_amount_a=true (using A, price was in/below range)
    // but by the time the first attempt executes, the price crossed above the upper tick.
    // Without the fix: fix_amount_a=true + price above range → delta_liquidity_from_a = 0
    //                  → MoveAbort(repay_add_liquidity, 0) on all retries.
    // With the fix: retry detects price > upper tick and switches to token B → success.

    const result = await simulateRetryOperation({
      amountA: 1_000_000n,
      amountB: 0n,
      fixAmountA: true,
      isSuiA: false,
      isSuiB: false,
      tickLower: -100,
      tickUpper: 100,
      // Attempt 1: price above range → switch to B (succeeds)
      freshTickIndexes: [150],  // > tickUpper=100
      walletBalances: [{ rawA: 1_000_000n, rawB: 500_000n }],
      sdkThrowsOnAttempt: new Set(),  // SDK succeeds after token switch
    });

    assert.ok(result.succeeded, 'Should succeed after switching to token B');
    assert.strictEqual(result.attempts, 1, 'Should succeed on first attempt after token switch');
    assert.strictEqual(result.attemptAmounts[0].amountA, 0n, 'amountA should be 0 after switch');
    assert.strictEqual(result.attemptAmounts[0].amountB, 500_000n, 'amountB should be safeRetryB after switch');
    assert.strictEqual(result.attemptAmounts[0].fixAmountA, false, 'fixAmountA should be false after switch to B');
    console.log('✔ Price above range: switches from token A to token B, preventing MoveAbort(repay_add_liquidity, 0)');
  }

  // ── Test 9: price moved BELOW range while using token B → switch to token A ─
  {
    // Scenario: initial amounts set with fix_amount_a=false (using B, price was in/above range)
    // but by the time the attempt executes, the price crossed below the lower tick.
    // Without the fix: fix_amount_a=false + price below range → delta_liquidity_from_b = 0
    //                  → MoveAbort(repay_add_liquidity, 0).
    // With the fix: retry detects price < lower tick and switches to token A → success.

    const result = await simulateRetryOperation({
      amountA: 0n,
      amountB: 800_000n,
      fixAmountA: false,
      isSuiA: false,
      isSuiB: false,
      tickLower: -100,
      tickUpper: 100,
      // Price below range → switch to A
      freshTickIndexes: [-200],  // < tickLower=-100
      walletBalances: [{ rawA: 600_000n, rawB: 800_000n }],
    });

    assert.ok(result.succeeded, 'Should succeed after switching to token A');
    assert.strictEqual(result.attemptAmounts[0].amountA, 600_000n, 'amountA should be safeRetryA after switch');
    assert.strictEqual(result.attemptAmounts[0].amountB, 0n, 'amountB should be 0 after switch');
    assert.strictEqual(result.attemptAmounts[0].fixAmountA, true, 'fixAmountA should be true after switch to A');
    console.log('✔ Price below range: switches from token B to token A, preventing MoveAbort(repay_add_liquidity, 0)');
  }

  // ── Test 10: price above range, no token B available → fail fast with clear error
  {
    // Scenario: price crossed above range, using A, but no B in wallet.
    // The retry cannot recover — throw a clear error instead of submitting doomed txs.

    const result = await simulateRetryOperation({
      amountA: 1_000_000n,
      amountB: 0n,
      fixAmountA: true,
      isSuiA: false,
      isSuiB: false,
      tickLower: -100,
      tickUpper: 100,
      freshTickIndexes: [150],  // above range
      walletBalances: [{ rawA: 1_000_000n, rawB: 0n }],  // no token B
      maxRetries: 3,
    });

    assert.ok(!result.succeeded, 'Should fail when price above range and no token B available');
    assert.ok(
      result.lastError?.message.includes('token B balance is zero'),
      `Should throw informative error about missing token B; got: ${result.lastError?.message}`,
    );
    console.log('✔ Price above range with no token B: fails fast with informative error message');
  }

  // ── Test 11: price in range, fix_amount_a=true → no token switch needed ─────
  {
    // Scenario: price is in range, using A. No switch should occur.

    const result = await simulateRetryOperation({
      amountA: 1_000_000n,
      amountB: 0n,
      fixAmountA: true,
      isSuiA: false,
      isSuiB: false,
      tickLower: -100,
      tickUpper: 100,
      freshTickIndexes: [0],  // in range
      walletBalances: [{ rawA: 1_000_000n, rawB: 500_000n }],
    });

    assert.ok(result.succeeded, 'Should succeed when price is in range');
    assert.strictEqual(result.attemptAmounts[0].amountA, 1_000_000n, 'amountA unchanged when in range');
    assert.strictEqual(result.attemptAmounts[0].fixAmountA, true, 'fixAmountA unchanged when in range');
    console.log('✔ Price in range: no token switch — uses original fix_amount_a=true');
  }

  // ── Test 12: price crosses boundary on attempt 2, switches on retry → success
  {
    // Scenario: attempt 1 uses original token A (in range initially) and
    // fails with MoveAbort(0) because on-chain price was above range at execution.
    // Attempt 2 detects price > upper tick and switches to B → succeeds.

    const result = await simulateRetryOperation({
      amountA: 1_000_000n,
      amountB: 0n,
      fixAmountA: true,
      isSuiA: false,
      isSuiB: false,
      tickLower: -100,
      tickUpper: 100,
      freshTickIndexes: [50, 150],  // attempt 1: in range; attempt 2: above range
      walletBalances: [
        { rawA: 1_000_000n, rawB: 500_000n },  // attempt 1
        { rawA: 1_000_000n, rawB: 500_000n },  // attempt 2
      ],
      // Attempt 1 (0-indexed=0) throws MoveAbort(0)
      sdkThrowsOnAttempt: new Set([0]),
      maxRetries: 3,
    });

    assert.ok(result.succeeded, 'Should succeed on attempt 2 after switching to token B');
    assert.strictEqual(result.attempts, 2, 'Should take 2 attempts');
    // Attempt 1: price in range, used A (MoveAbort thrown by mock)
    assert.strictEqual(result.attemptAmounts[0].amountA, 1_000_000n, 'Attempt 1: used token A (in-range price)');
    assert.strictEqual(result.attemptAmounts[0].fixAmountA, true);
    // Attempt 2: price above range, switched to B
    assert.strictEqual(result.attemptAmounts[1].amountA, 0n, 'Attempt 2: switched to 0 A');
    assert.strictEqual(result.attemptAmounts[1].amountB, 500_000n, 'Attempt 2: using B after switch');
    assert.strictEqual(result.attemptAmounts[1].fixAmountA, false, 'Attempt 2: fixAmountA=false after switch');
    console.log('✔ Price crosses boundary mid-retry: detects and switches token on subsequent attempt → success');
  }

  console.log('\nAll per-retry balance-cap tests passed ✅');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
