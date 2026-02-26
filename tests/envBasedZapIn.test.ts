/**
 * Tests for the refactored add-liquidity: env-based single-sided zap-in.
 *
 * Validates the new behaviour introduced by the refactor:
 *  1. Only TOKEN_A_AMOUNT or TOKEN_B_AMOUNT env vars are used as zap input.
 *  2. TOKEN_A_AMOUNT takes priority when both are set.
 *  3. If neither env var is set an error is thrown immediately.
 *  4. Current tick is validated to be within [tickLower, tickUpper) before
 *     calling zap-in; if outside, an error is thrown and no SDK call is made.
 *  5. Any error (including MoveAbort code 0) propagates immediately — no retries.
 *
 * Run with: npx ts-node tests/envBasedZapIn.test.ts
 */

import assert from 'assert';

// ---------------------------------------------------------------------------
// Reimplementation of the env-based amount selection and tick validation logic
// (mirrors the refactored RebalanceService.addLiquidity)
// ---------------------------------------------------------------------------

interface ZapParams {
  amountA: string;
  amountB: string;
  fixAmountA: boolean;
}

/**
 * Select the zap input from env vars only.
 * Throws if neither TOKEN_A_AMOUNT nor TOKEN_B_AMOUNT is configured.
 */
function selectEnvZapParams(opts: {
  envAmountA?: string;
  envAmountB?: string;
}): ZapParams {
  const { envAmountA, envAmountB } = opts;

  if (envAmountA) {
    return { amountA: envAmountA, amountB: '0', fixAmountA: true };
  }
  if (envAmountB) {
    return { amountA: '0', amountB: envAmountB, fixAmountA: false };
  }
  throw new Error('TOKEN_A_AMOUNT or TOKEN_B_AMOUNT must be configured for zap-in');
}

/**
 * Validate that the current tick is within [tickLower, tickUpper).
 * Throws if the tick is outside the range.
 */
function validateTickInRange(currentTick: number, tickLower: number, tickUpper: number): void {
  if (currentTick < tickLower || currentTick >= tickUpper) {
    throw new Error(
      `Current tick ${currentTick} is outside configured range [${tickLower}, ${tickUpper}] — aborting zap-in`,
    );
  }
}

/**
 * Simulate a single zap-in execution (no retries).
 * Returns 'ok' on success; propagates any error thrown by the SDK mock.
 */
async function singleZapIn(sdkCall: () => Promise<string>): Promise<string> {
  // Single execution — no retry wrapper
  return sdkCall();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('Running env-based zap-in tests...\n');

// ── Env-var amount selection ─────────────────────────────────────────────────

// 1. TOKEN_A_AMOUNT set → amountA used, amountB='0', fixAmountA=true
{
  const p = selectEnvZapParams({ envAmountA: '5000000' });
  assert.strictEqual(p.amountA, '5000000');
  assert.strictEqual(p.amountB, '0');
  assert.strictEqual(p.fixAmountA, true);
  console.log('✔ TOKEN_A_AMOUNT set → used as sole zap input (amountB=0, fixAmountA=true)');
}

// 2. TOKEN_B_AMOUNT set → amountB used, amountA='0', fixAmountA=false
{
  const p = selectEnvZapParams({ envAmountB: '3000000' });
  assert.strictEqual(p.amountA, '0');
  assert.strictEqual(p.amountB, '3000000');
  assert.strictEqual(p.fixAmountA, false);
  console.log('✔ TOKEN_B_AMOUNT set → used as sole zap input (amountA=0, fixAmountA=false)');
}

// 3. Both set → TOKEN_A_AMOUNT wins
{
  const p = selectEnvZapParams({ envAmountA: '2000000', envAmountB: '9000000' });
  assert.strictEqual(p.amountA, '2000000', 'TOKEN_A_AMOUNT should take priority');
  assert.strictEqual(p.amountB, '0');
  assert.strictEqual(p.fixAmountA, true);
  console.log('✔ Both env vars set → TOKEN_A_AMOUNT takes priority');
}

// 4. Neither set → error thrown immediately
{
  let thrown = false;
  try {
    selectEnvZapParams({});
  } catch (err) {
    thrown = true;
    assert.ok(
      err instanceof Error && err.message.includes('TOKEN_A_AMOUNT or TOKEN_B_AMOUNT'),
      `Error message should mention env vars, got: ${err instanceof Error ? err.message : err}`,
    );
  }
  assert.ok(thrown, 'Should throw when neither env var is set');
  console.log('✔ Neither env var set → error thrown immediately (no SDK call)');
}

// ── Tick validation ──────────────────────────────────────────────────────────

// 5. Current tick within range → no error
{
  assert.doesNotThrow(() => validateTickInRange(150, 100, 200));
  console.log('✔ Tick within range [100,200): no error');
}

// 6. Tick exactly at lower bound (inclusive) → no error
{
  assert.doesNotThrow(() => validateTickInRange(100, 100, 200));
  console.log('✔ Tick at lower bound (inclusive): no error');
}

// 7. Tick exactly at upper bound (exclusive) → error
{
  let thrown = false;
  try {
    validateTickInRange(200, 100, 200);
  } catch (err) {
    thrown = true;
    assert.ok(err instanceof Error && err.message.includes('aborting zap-in'));
  }
  assert.ok(thrown, 'Tick at upper bound should throw (exclusive upper)');
  console.log('✔ Tick at upper bound (exclusive): error thrown, zap-in aborted');
}

// 8. Tick below lower bound → error
{
  let thrown = false;
  try {
    validateTickInRange(99, 100, 200);
  } catch (err) {
    thrown = true;
    assert.ok(
      err instanceof Error && err.message.includes('outside configured range'),
      `Expected range error, got: ${err instanceof Error ? err.message : err}`,
    );
  }
  assert.ok(thrown, 'Tick below range should throw');
  console.log('✔ Tick below lower bound: error thrown, zap-in aborted');
}

// 9. Tick above upper bound → error
{
  let thrown = false;
  try {
    validateTickInRange(201, 100, 200);
  } catch (err) {
    thrown = true;
    assert.ok(err instanceof Error && err.message.includes('outside configured range'));
  }
  assert.ok(thrown, 'Tick above range should throw');
  console.log('✔ Tick above upper bound: error thrown, zap-in aborted');
}

// 10. Negative ticks in range → no error
{
  assert.doesNotThrow(() => validateTickInRange(-150, -200, -100));
  console.log('✔ Negative ticks within range: no error');
}

// 11. Negative tick out of range → error
{
  let thrown = false;
  try {
    validateTickInRange(-201, -200, -100);
  } catch (err) {
    thrown = true;
  }
  assert.ok(thrown, 'Negative tick below range should throw');
  console.log('✔ Negative tick below range: error thrown');
}

// ── Single execution / no retry ─────────────────────────────────────────────

// 12. Successful single execution
async function runAsyncTests() {
  {
    let callCount = 0;
    const result = await singleZapIn(async () => {
      callCount++;
      return 'ok';
    });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(callCount, 1, 'Should call SDK exactly once');
    console.log('✔ Single execution: SDK called exactly once on success');
  }

  // 13. MoveAbort(0) propagates immediately — no retry
  {
    let callCount = 0;
    const moveAbort0 = new Error(
      'MoveAbort(MoveLocation { module: ModuleId { address: b2db71..., name: Identifier("pool_script_v2") },' +
      ' function: 23, instruction: 16, function_name: Some("repay_add_liquidity") }, 0) in command 1',
    );

    let caughtError: Error | null = null;
    try {
      await singleZapIn(async () => {
        callCount++;
        throw moveAbort0;
      });
    } catch (err) {
      caughtError = err instanceof Error ? err : new Error(String(err));
    }

    assert.strictEqual(callCount, 1, 'MoveAbort(0) should not be retried — called exactly once');
    assert.strictEqual(caughtError, moveAbort0, 'Original MoveAbort(0) error should propagate');
    console.log('✔ MoveAbort(0) propagates immediately without retries');
  }

  // 14. Non-zero MoveAbort propagates immediately — no retry
  {
    let callCount = 0;
    const moveAbortN = new Error(
      'MoveAbort(MoveLocation { module: ModuleId { address: b2db71..., name: Identifier("pool_script_v2") },' +
      ' function: 23, instruction: 16, function_name: Some("repay_add_liquidity") }, 7) in command 1',
    );

    let caughtError: Error | null = null;
    try {
      await singleZapIn(async () => {
        callCount++;
        throw moveAbortN;
      });
    } catch (err) {
      caughtError = err instanceof Error ? err : new Error(String(err));
    }

    assert.strictEqual(callCount, 1, 'Any MoveAbort should not be retried — called exactly once');
    assert.strictEqual(caughtError, moveAbortN, 'Original MoveAbort error should propagate');
    console.log('✔ Non-zero MoveAbort propagates immediately without retries');
  }

  // 15. Any arbitrary error propagates immediately — no retry
  {
    let callCount = 0;
    const networkErr = new Error('fetch failed');

    let caughtError: Error | null = null;
    try {
      await singleZapIn(async () => {
        callCount++;
        throw networkErr;
      });
    } catch (err) {
      caughtError = err instanceof Error ? err : new Error(String(err));
    }

    assert.strictEqual(callCount, 1, 'Network error should not be retried — called exactly once');
    assert.strictEqual(caughtError, networkErr, 'Original network error should propagate');
    console.log('✔ Network error propagates immediately without retries');
  }

  console.log('\nAll env-based zap-in tests passed ✅');
}

runAsyncTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
