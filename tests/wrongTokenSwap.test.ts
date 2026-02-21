/**
 * Tests for the wrong-token swap logic added to addLiquidity.
 *
 * When close_position returns only token B (e.g. price rose above the old
 * position's upper tick) but the new position happens to be below the current
 * price, the bot must swap ALL of token B to token A before adding liquidity.
 * The symmetric case (only token A, position above range) is also covered.
 *
 * Run with: npx ts-node --compiler-options '{"lib":["ES2020","dom"],"types":["node"]}' tests/wrongTokenSwap.test.ts
 */

import assert from 'assert';

// ---------------------------------------------------------------------------
// Pure reimplementation of the wrong-token swap detection logic
// ---------------------------------------------------------------------------

interface WrongTokenSwapDecision {
  needsSwap: boolean;
  aToB?: boolean;       // true = swap A→B (all A), false = swap B→A (all B)
  swapAmount?: string;
}

/**
 * Detects whether a full wrong-token swap is needed for an out-of-range
 * position.  Mirrors the new block added to RebalanceService.addLiquidity.
 */
function detectWrongTokenSwap(
  priceIsBelowRange: boolean,
  priceIsAboveRange: boolean,
  amountA: string,
  amountB: string,
): WrongTokenSwapDecision {
  const bigA = BigInt(amountA);
  const bigB = BigInt(amountB);

  if (priceIsBelowRange && bigA === 0n && bigB > 0n) {
    // Position below range needs only token A but we only have token B → swap all B→A
    return { needsSwap: true, aToB: false, swapAmount: amountB };
  }

  if (priceIsAboveRange && bigB === 0n && bigA > 0n) {
    // Position above range needs only token B but we only have token A → swap all A→B
    return { needsSwap: true, aToB: true, swapAmount: amountA };
  }

  return { needsSwap: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('Running wrong-token swap tests...\n');

// 1. Below range, only token B available → swap B→A (all of it)
{
  const r = detectWrongTokenSwap(true, false, '0', '5000000');
  assert.strictEqual(r.needsSwap, true);
  assert.strictEqual(r.aToB, false, 'should swap B→A');
  assert.strictEqual(r.swapAmount, '5000000');
  console.log('✔ below-range, only B → swap all B→A');
}

// 2. Above range, only token A available → swap A→B (all of it)
{
  const r = detectWrongTokenSwap(false, true, '3000000', '0');
  assert.strictEqual(r.needsSwap, true);
  assert.strictEqual(r.aToB, true, 'should swap A→B');
  assert.strictEqual(r.swapAmount, '3000000');
  console.log('✔ above-range, only A → swap all A→B');
}

// 3. Below range, correct token (A) available → no swap
{
  const r = detectWrongTokenSwap(true, false, '5000000', '0');
  assert.strictEqual(r.needsSwap, false);
  console.log('✔ below-range, have A → no wrong-token swap needed');
}

// 4. Above range, correct token (B) available → no swap
{
  const r = detectWrongTokenSwap(false, true, '0', '4000000');
  assert.strictEqual(r.needsSwap, false);
  console.log('✔ above-range, have B → no wrong-token swap needed');
}

// 5. In-range (neither above nor below) → wrong-token swap never triggers
{
  const r = detectWrongTokenSwap(false, false, '0', '5000000');
  assert.strictEqual(r.needsSwap, false, 'in-range uses the separate zap-in half-swap, not wrong-token swap');
  console.log('✔ in-range with only B → wrong-token swap does NOT trigger (in-range zap handles it)');
}

// 6. In-range with only A → same
{
  const r = detectWrongTokenSwap(false, false, '5000000', '0');
  assert.strictEqual(r.needsSwap, false);
  console.log('✔ in-range with only A → wrong-token swap does NOT trigger');
}

// 7. Below range with both tokens → no wrong-token swap (already have A)
{
  const r = detectWrongTokenSwap(true, false, '2000000', '3000000');
  assert.strictEqual(r.needsSwap, false);
  console.log('✔ below-range, have both tokens → no wrong-token swap');
}

// 8. Above range with both tokens → no wrong-token swap (already have B)
{
  const r = detectWrongTokenSwap(false, true, '1000000', '2000000');
  assert.strictEqual(r.needsSwap, false);
  console.log('✔ above-range, have both tokens → no wrong-token swap');
}

// 9. Below range, both amounts zero → no swap (caught by earlier balance check)
{
  const r = detectWrongTokenSwap(true, false, '0', '0');
  assert.strictEqual(r.needsSwap, false);
  console.log('✔ below-range, both zero → no swap (insufficient balance guard applies)');
}

// 10. Realistic rebalance scenario: old position above old range → received only B,
//     price then moves further so new range is also below current price.
{
  // close_position returned: amountA='0', amountB='8000000'
  // New position ticks: lower=300, upper=400
  // Fresh current tick: 280  (below new range → priceIsBelowRange)
  const r = detectWrongTokenSwap(true, false, '0', '8000000');
  assert.strictEqual(r.needsSwap, true);
  assert.strictEqual(r.aToB, false);
  assert.strictEqual(r.swapAmount, '8000000');
  console.log('✔ realistic: received B from close, new pos below range → swap all B→A');
}

// 11. Realistic rebalance scenario: old position below old range → received only A,
//     price then moves further up so new range is above current price.
{
  // close_position returned: amountA='6000000', amountB='0'
  // Fresh current tick: 520 >= upper (420) → priceIsAboveRange
  const r = detectWrongTokenSwap(false, true, '6000000', '0');
  assert.strictEqual(r.needsSwap, true);
  assert.strictEqual(r.aToB, true);
  assert.strictEqual(r.swapAmount, '6000000');
  console.log('✔ realistic: received A from close, new pos above range → swap all A→B');
}

console.log('\nAll wrong-token swap tests passed ✅');
