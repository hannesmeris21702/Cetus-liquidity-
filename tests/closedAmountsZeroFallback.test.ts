/**
 * Tests for the closedPositionAmounts both-zero fallback in addLiquidity.
 *
 * When removeLiquidity succeeds but balance-change parsing returns 0 for both
 * tokens (e.g. net SUI change is negative because gas > SUI received from the
 * position), the addLiquidity method must NOT throw "Insufficient token balance".
 * Instead it should fall back to wallet balance so the freed tokens can be used.
 *
 * Run with: npx ts-node tests/closedAmountsZeroFallback.test.ts
 */

import assert from 'assert';

// ── Inline reimplementation of the fixed amount-selection logic ─────────────
// Mirrors the code in RebalanceService.addLiquidity after the fix.

function calculateZapAmount(removedAmount: bigint, safeBalance: bigint): string {
  if (removedAmount <= 0n) return '0';
  if (safeBalance === 0n) return removedAmount.toString();
  return (removedAmount <= safeBalance ? removedAmount : safeBalance).toString();
}

function selectZapAmounts(
  closedPositionAmounts: { amountA: string; amountB: string } | undefined,
  safeBalanceA: bigint,
  safeBalanceB: bigint,
  priceIsBelowRange: boolean,
  priceIsAboveRange: boolean,
): { amountA: string; amountB: string } {
  let amountA: string;
  let amountB: string;

  if (closedPositionAmounts) {
    const removedA = BigInt(closedPositionAmounts.amountA);
    const removedB = BigInt(closedPositionAmounts.amountB);
    if (removedA > 0n || removedB > 0n) {
      // Use freed token amounts (normal rebalancing case).
      amountA = calculateZapAmount(removedA, safeBalanceA);
      amountB = calculateZapAmount(removedB, safeBalanceB);
    } else {
      // Balance change parsing returned 0,0 — fall back to wallet balance.
      if (priceIsBelowRange) {
        amountA = safeBalanceA.toString();
        amountB = '0';
      } else if (priceIsAboveRange) {
        amountA = '0';
        amountB = safeBalanceB.toString();
      } else {
        amountA = safeBalanceA.toString();
        amountB = safeBalanceB.toString();
      }
    }
  } else if (priceIsBelowRange) {
    amountA = safeBalanceA.toString();
    amountB = '0';
  } else if (priceIsAboveRange) {
    amountA = '0';
    amountB = safeBalanceB.toString();
  } else {
    amountA = safeBalanceA.toString();
    amountB = safeBalanceB.toString();
  }

  return { amountA, amountB };
}

function wouldThrowInsufficientBalance(amountA: string, amountB: string): boolean {
  return BigInt(amountA) === 0n && BigInt(amountB) === 0n;
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('Running closedPositionAmounts both-zero fallback tests...\n');

// 1. BUG SCENARIO: balance-change parsing returned 0,0 — price is in range
//    Both wallet balances are available.  Must NOT throw.
{
  const closed = { amountA: '0', amountB: '0' };
  const { amountA, amountB } = selectZapAmounts(closed, 5_000_000n, 3_000_000n, false, false);
  assert.ok(!wouldThrowInsufficientBalance(amountA, amountB),
    'should NOT throw when wallet balance available after parsing failure (in-range)');
  assert.strictEqual(amountA, '5000000', 'should use safeBalanceA as fallback');
  assert.strictEqual(amountB, '3000000', 'should use safeBalanceB as fallback');
  console.log('✔ both-zero closed amounts, in-range price → falls back to wallet balance');
}

// 2. BUG SCENARIO: balance-change parsing returned 0,0 — price is below range
//    Only token A is needed for a below-range position.
{
  const closed = { amountA: '0', amountB: '0' };
  const { amountA, amountB } = selectZapAmounts(closed, 4_000_000n, 2_000_000n, true, false);
  assert.ok(!wouldThrowInsufficientBalance(amountA, amountB),
    'should NOT throw when wallet has tokenA (below-range, parsing failure)');
  assert.strictEqual(amountA, '4000000', 'should use safeBalanceA for below-range fallback');
  assert.strictEqual(amountB, '0', 'tokenB not needed for below-range position');
  console.log('✔ both-zero closed amounts, below-range price → uses tokenA from wallet');
}

// 3. BUG SCENARIO: balance-change parsing returned 0,0 — price is above range
//    Only token B is needed for an above-range position.
{
  const closed = { amountA: '0', amountB: '0' };
  const { amountA, amountB } = selectZapAmounts(closed, 4_000_000n, 2_000_000n, false, true);
  assert.ok(!wouldThrowInsufficientBalance(amountA, amountB),
    'should NOT throw when wallet has tokenB (above-range, parsing failure)');
  assert.strictEqual(amountA, '0', 'tokenA not needed for above-range position');
  assert.strictEqual(amountB, '2000000', 'should use safeBalanceB for above-range fallback');
  console.log('✔ both-zero closed amounts, above-range price → uses tokenB from wallet');
}

// 4. NORMAL CASE: one token returned from close — must NOT trigger fallback
{
  const closed = { amountA: '0', amountB: '1500000' };
  const { amountA, amountB } = selectZapAmounts(closed, 5_000_000n, 3_000_000n, false, false);
  assert.strictEqual(amountA, '0', 'amountA should be 0 (none freed)');
  assert.strictEqual(amountB, '1500000', 'amountB should use freed amount');
  console.log('✔ one non-zero closed amount → uses freed amounts, no fallback triggered');
}

// 5. NORMAL CASE: both tokens returned from close — must NOT trigger fallback
{
  const closed = { amountA: '2000000', amountB: '4000000' };
  const { amountA, amountB } = selectZapAmounts(closed, 10_000_000n, 10_000_000n, false, false);
  assert.strictEqual(amountA, '2000000', 'should use exact freed amount A');
  assert.strictEqual(amountB, '4000000', 'should use exact freed amount B');
  console.log('✔ both non-zero closed amounts → uses freed amounts (normal rebalance)');
}

// 6. EDGE CASE: wallet balance also 0 after fallback — still throws (correctly)
{
  const closed = { amountA: '0', amountB: '0' };
  const { amountA, amountB } = selectZapAmounts(closed, 0n, 0n, false, false);
  assert.ok(wouldThrowInsufficientBalance(amountA, amountB),
    'should still throw when wallet is also empty after fallback');
  console.log('✔ both-zero closed amounts + empty wallet → would throw (correctly)');
}

// 7. NO closedPositionAmounts (first-time position creation) — existing behaviour preserved
{
  // Below-range: only token A needed
  const { amountA, amountB } = selectZapAmounts(undefined, 8_000_000n, 5_000_000n, true, false);
  assert.strictEqual(amountA, '8000000');
  assert.strictEqual(amountB, '0');
  console.log('✔ no closedPositionAmounts, below-range → wallet balance A (no regression)');
}

{
  // Above-range: only token B needed
  const { amountA, amountB } = selectZapAmounts(undefined, 8_000_000n, 5_000_000n, false, true);
  assert.strictEqual(amountA, '0');
  assert.strictEqual(amountB, '5000000');
  console.log('✔ no closedPositionAmounts, above-range → wallet balance B (no regression)');
}

{
  // In-range: both tokens
  const { amountA, amountB } = selectZapAmounts(undefined, 8_000_000n, 5_000_000n, false, false);
  assert.strictEqual(amountA, '8000000');
  assert.strictEqual(amountB, '5000000');
  console.log('✔ no closedPositionAmounts, in-range → both wallet balances (no regression)');
}

console.log('\nAll closedPositionAmounts both-zero fallback tests passed ✅');
