/**
 * Tests for the closedPositionAmounts both-zero fallback in addLiquidity.
 *
 * When removeLiquidity succeeds but balance-change parsing returns 0 for both
 * tokens (e.g. net SUI change is negative because gas > SUI received from the
 * position), the addLiquidity method must NOT throw "Insufficient token balance".
 * Instead it should fall back to wallet balance so the freed tokens can be used.
 *
 * The Cetus SDK zap-in takes a SINGLE token as input; the SDK handles the
 * internal swap.  The bot always sets exactly one non-zero amount.
 *
 * Run with: npx ts-node tests/closedAmountsZeroFallback.test.ts
 */

import assert from 'assert';

// ── Inline reimplementation of the fixed amount-selection logic ─────────────
// Mirrors the code in RebalanceService.addLiquidity after the single-token zap fix.

function calculateZapAmount(removedAmount: bigint, safeBalance: bigint): string {
  if (removedAmount <= 0n) return '0';
  if (safeBalance === 0n) return removedAmount.toString();
  return (removedAmount <= safeBalance ? removedAmount : safeBalance).toString();
}

/**
 * Pick exactly ONE token for the zap-in call.
 *
 * Priority:
 *   1. closedPositionAmounts (non-zero): prefer A unless above-range or A was 0.
 *   2. closedPositionAmounts (both zero): fallback to wallet, same preference.
 *   3. No closedPositionAmounts: use range to decide.
 */
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
      // Pick the single token the new position range requires.
      // Below-range or in-range: prefer A. Above-range or no freed A: use B.
      if (!priceIsAboveRange && removedA > 0n) {
        amountA = calculateZapAmount(removedA, safeBalanceA);
        amountB = '0';
      } else {
        amountA = '0';
        amountB = removedB > 0n
          ? calculateZapAmount(removedB, safeBalanceB)
          : safeBalanceB.toString();
      }
    } else {
      // Balance change parsing returned 0,0 — fall back to wallet balance.
      // Still use only one token.
      if (!priceIsAboveRange && safeBalanceA > 0n) {
        amountA = safeBalanceA.toString();
        amountB = '0';
      } else {
        amountA = '0';
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
    // In-range: prefer A; fall back to B if no A available.
    if (safeBalanceA > 0n) {
      amountA = safeBalanceA.toString();
      amountB = '0';
    } else {
      amountA = '0';
      amountB = safeBalanceB.toString();
    }
  }

  return { amountA, amountB };
}

function wouldThrowInsufficientBalance(amountA: string, amountB: string): boolean {
  return BigInt(amountA) === 0n && BigInt(amountB) === 0n;
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('Running closedPositionAmounts both-zero fallback tests...\n');

// 1. Both-zero fallback: in-range price, token A available → use A only
{
  const closed = { amountA: '0', amountB: '0' };
  const { amountA, amountB } = selectZapAmounts(closed, 5_000_000n, 3_000_000n, false, false);
  assert.ok(!wouldThrowInsufficientBalance(amountA, amountB),
    'should NOT throw when wallet balance available after parsing failure (in-range)');
  assert.strictEqual(amountA, '5000000', 'should use safeBalanceA as fallback');
  assert.strictEqual(amountB, '0', 'amountB must be 0 (single-token zap)');
  console.log('✔ both-zero closed amounts, in-range price → falls back to wallet A only');
}

// 2. Both-zero fallback: below-range price → use A only
{
  const closed = { amountA: '0', amountB: '0' };
  const { amountA, amountB } = selectZapAmounts(closed, 4_000_000n, 2_000_000n, true, false);
  assert.ok(!wouldThrowInsufficientBalance(amountA, amountB),
    'should NOT throw when wallet has tokenA (below-range, parsing failure)');
  assert.strictEqual(amountA, '4000000', 'should use safeBalanceA for below-range fallback');
  assert.strictEqual(amountB, '0', 'tokenB not needed; amountB must be 0');
  console.log('✔ both-zero closed amounts, below-range price → uses tokenA from wallet');
}

// 3. Both-zero fallback: above-range price → use B only
{
  const closed = { amountA: '0', amountB: '0' };
  const { amountA, amountB } = selectZapAmounts(closed, 4_000_000n, 2_000_000n, false, true);
  assert.ok(!wouldThrowInsufficientBalance(amountA, amountB),
    'should NOT throw when wallet has tokenB (above-range, parsing failure)');
  assert.strictEqual(amountA, '0', 'tokenA not needed; amountA must be 0');
  assert.strictEqual(amountB, '2000000', 'should use safeBalanceB for above-range fallback');
  console.log('✔ both-zero closed amounts, above-range price → uses tokenB from wallet');
}

// 4. Normal case: only B returned from close (in-range) → use B
{
  const closed = { amountA: '0', amountB: '1500000' };
  const { amountA, amountB } = selectZapAmounts(closed, 5_000_000n, 3_000_000n, false, false);
  assert.strictEqual(amountA, '0', 'amountA should be 0 (none freed, above-range path taken)');
  assert.strictEqual(amountB, '1500000', 'amountB should use freed amount');
  console.log('✔ only freed B (in-range) → uses B only, no fallback triggered');
}

// 5. Normal case: only A returned from close (in-range) → use A only
{
  const closed = { amountA: '2000000', amountB: '0' };
  const { amountA, amountB } = selectZapAmounts(closed, 10_000_000n, 10_000_000n, false, false);
  assert.strictEqual(amountA, '2000000', 'should use exact freed amount A');
  assert.strictEqual(amountB, '0', 'amountB must be 0 (single-token zap)');
  console.log('✔ only freed A (in-range) → uses A only (single-token zap)');
}

// 6. Normal case: both tokens freed from close (in-range) → use A only (prefer A)
{
  const closed = { amountA: '2000000', amountB: '4000000' };
  const { amountA, amountB } = selectZapAmounts(closed, 10_000_000n, 10_000_000n, false, false);
  assert.strictEqual(amountA, '2000000', 'should use freed A as single zap input');
  assert.strictEqual(amountB, '0', 'amountB must be 0 (single-token zap)');
  console.log('✔ both non-zero closed amounts, in-range → uses freed A only (prefer A)');
}

// 7. Both non-zero freed amounts, above-range → use B only
{
  const closed = { amountA: '2000000', amountB: '4000000' };
  const { amountA, amountB } = selectZapAmounts(closed, 10_000_000n, 10_000_000n, false, true);
  assert.strictEqual(amountA, '0', 'amountA must be 0 (above-range → use B)');
  assert.strictEqual(amountB, '4000000', 'should use freed B');
  console.log('✔ both non-zero closed amounts, above-range → uses freed B only');
}

// 8. EDGE CASE: wallet balance also 0 after fallback — still throws (correctly)
{
  const closed = { amountA: '0', amountB: '0' };
  const { amountA, amountB } = selectZapAmounts(closed, 0n, 0n, false, false);
  assert.ok(wouldThrowInsufficientBalance(amountA, amountB),
    'should still throw when wallet is also empty after fallback');
  console.log('✔ both-zero closed amounts + empty wallet → would throw (correctly)');
}

// 9. No closedPositionAmounts — below-range: A only
{
  const { amountA, amountB } = selectZapAmounts(undefined, 8_000_000n, 5_000_000n, true, false);
  assert.strictEqual(amountA, '8000000');
  assert.strictEqual(amountB, '0');
  console.log('✔ no closedPositionAmounts, below-range → wallet balance A only');
}

// 10. No closedPositionAmounts — above-range: B only
{
  const { amountA, amountB } = selectZapAmounts(undefined, 8_000_000n, 5_000_000n, false, true);
  assert.strictEqual(amountA, '0');
  assert.strictEqual(amountB, '5000000');
  console.log('✔ no closedPositionAmounts, above-range → wallet balance B only');
}

// 11. No closedPositionAmounts — in-range with A available: A only
{
  const { amountA, amountB } = selectZapAmounts(undefined, 8_000_000n, 5_000_000n, false, false);
  assert.strictEqual(amountA, '8000000', 'prefer A when available (single-token zap)');
  assert.strictEqual(amountB, '0', 'amountB must be 0 (single-token zap)');
  console.log('✔ no closedPositionAmounts, in-range → wallet A only (single-token zap)');
}

// 12. No closedPositionAmounts — in-range, no A: B only
{
  const { amountA, amountB } = selectZapAmounts(undefined, 0n, 5_000_000n, false, false);
  assert.strictEqual(amountA, '0');
  assert.strictEqual(amountB, '5000000');
  console.log('✔ no closedPositionAmounts, in-range, no A → wallet B only (fallback)');
}

console.log('\nAll closedPositionAmounts both-zero fallback tests passed ✅');
