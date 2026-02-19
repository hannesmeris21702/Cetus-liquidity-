/**
 * Tests for the zapin balance-race-condition fix.
 *
 * After close_position the wallet's on-chain balance may not yet be visible
 * through the RPC balance query.  calculateZapAmount must still return the
 * closed-position amount rather than '0' so the subsequent add-liquidity
 * call can proceed.
 *
 * Run with: npx ts-node tests/zapinBalanceRace.test.ts
 */

import assert from 'assert';

/**
 * Inline copy of the fixed calculateZapAmount logic, extracted so it can
 * be tested without instantiating the full RebalanceService.
 */
function calculateZapAmount(removedAmount: bigint, safeBalance: bigint): string {
  if (removedAmount <= 0n) return '0';
  // If the balance query returned 0 but we received a positive amount from
  // closing the position, the on-chain state may not yet be reflected in the
  // balance RPC response.  Trust the closed-position amount so the zap can
  // proceed with the tokens that were just returned to the wallet.
  if (safeBalance === 0n) return removedAmount.toString();
  return (removedAmount <= safeBalance ? removedAmount : safeBalance).toString();
}

/**
 * Simulate whether the "Insufficient token balance" error would be thrown.
 */
function wouldThrowInsufficientBalance(amountA: string, amountB: string): boolean {
  return BigInt(amountA) === 0n && BigInt(amountB) === 0n;
}

console.log('Running zapin balance-race-condition tests...\n');

// ── calculateZapAmount unit tests ─────────────────────────────────────────

// Normal case: removedAmount ≤ safeBalance → use removedAmount
{
  const result = calculateZapAmount(1_000_000n, 5_000_000n);
  assert.strictEqual(result, '1000000');
  console.log('✔ removedAmount ≤ safeBalance → returns removedAmount');
}

// Cap case: removedAmount > safeBalance → cap to safeBalance
{
  const result = calculateZapAmount(5_000_000n, 3_000_000n);
  assert.strictEqual(result, '3000000');
  console.log('✔ removedAmount > safeBalance → caps to safeBalance');
}

// Zero removedAmount → always 0
{
  const result = calculateZapAmount(0n, 5_000_000n);
  assert.strictEqual(result, '0');
  console.log('✔ removedAmount = 0 → returns 0');
}

// Negative removedAmount → always 0
{
  const result = calculateZapAmount(-1n, 5_000_000n);
  assert.strictEqual(result, '0');
  console.log('✔ removedAmount < 0 → returns 0');
}

// ── Race-condition fix ─────────────────────────────────────────────────────

// BUG SCENARIO (pre-fix): removedAmount > 0 but safeBalance = 0 (balance RPC
// lag after close_position).  The old code returned '0' because
// min(removedAmount, 0) = 0.
// FIXED: returns removedAmount when safeBalance = 0.
{
  const result = calculateZapAmount(5_000_000n, 0n);
  assert.strictEqual(result, '5000000', 'must use removedAmount when safeBalance is 0');
  console.log('✔ removedAmount > 0, safeBalance = 0 (race condition) → returns removedAmount (fix verified)');
}

// ── End-to-end simulation of the failing scenario ─────────────────────────

// Scenario A: position was above range → only token B received.
// After close, safeBalanceB RPC returns 0 (timing issue), safeBalanceA = 0.
{
  const closedAmounts = { amountA: '0', amountB: '5000000' };
  const safeBalanceA = 0n;
  const safeBalanceB = 0n; // RPC lag

  const amountA = calculateZapAmount(BigInt(closedAmounts.amountA), safeBalanceA);
  const amountB = calculateZapAmount(BigInt(closedAmounts.amountB), safeBalanceB);

  assert.strictEqual(amountB, '5000000', 'amountB should use closed amount despite 0 balance');
  assert.strictEqual(wouldThrowInsufficientBalance(amountA, amountB), false,
    'should NOT throw insufficient balance when token B was received from close');
  console.log('✔ above-range position, safeBalanceB=0 race condition → proceeds with closed amountB');
}

// Scenario B: position was below range → only token A received.
// After close, safeBalanceA RPC returns 0, safeBalanceB = 0.
{
  const closedAmounts = { amountA: '3000000', amountB: '0' };
  const safeBalanceA = 0n; // RPC lag
  const safeBalanceB = 0n;

  const amountA = calculateZapAmount(BigInt(closedAmounts.amountA), safeBalanceA);
  const amountB = calculateZapAmount(BigInt(closedAmounts.amountB), safeBalanceB);

  assert.strictEqual(amountA, '3000000', 'amountA should use closed amount despite 0 balance');
  assert.strictEqual(wouldThrowInsufficientBalance(amountA, amountB), false,
    'should NOT throw insufficient balance when token A was received from close');
  console.log('✔ below-range position, safeBalanceA=0 race condition → proceeds with closed amountA');
}

// Scenario C: in-range position → both tokens received.
// Both balances RPC 0.
{
  const closedAmounts = { amountA: '2000000', amountB: '4000000' };
  const safeBalanceA = 0n; // RPC lag
  const safeBalanceB = 0n; // RPC lag

  const amountA = calculateZapAmount(BigInt(closedAmounts.amountA), safeBalanceA);
  const amountB = calculateZapAmount(BigInt(closedAmounts.amountB), safeBalanceB);

  assert.strictEqual(amountA, '2000000');
  assert.strictEqual(amountB, '4000000');
  assert.strictEqual(wouldThrowInsufficientBalance(amountA, amountB), false,
    'should NOT throw when both tokens were received from close');
  console.log('✔ in-range position, both balances 0 race condition → proceeds with closed amounts');
}

// Scenario D: balance settled correctly (> 0) — existing behaviour unchanged.
{
  const closedAmounts = { amountA: '2000000', amountB: '4000000' };
  const safeBalanceA = 2_500_000n;
  const safeBalanceB = 4_500_000n;

  const amountA = calculateZapAmount(BigInt(closedAmounts.amountA), safeBalanceA);
  const amountB = calculateZapAmount(BigInt(closedAmounts.amountB), safeBalanceB);

  assert.strictEqual(amountA, '2000000', 'uses closed amount when balance ≥ closed amount');
  assert.strictEqual(amountB, '4000000', 'uses closed amount when balance ≥ closed amount');
  console.log('✔ settled balances → uses closed amount as before (no regression)');
}

// Scenario E: gas consumed some SUI — cap to safeBalance (existing behaviour).
{
  const closedAmounts = { amountA: '2000000', amountB: '4000000' };
  // safeBalance slightly below closed amount because gas was deducted
  const safeBalanceA = 1_900_000n;
  const safeBalanceB = 3_800_000n;

  const amountA = calculateZapAmount(BigInt(closedAmounts.amountA), safeBalanceA);
  const amountB = calculateZapAmount(BigInt(closedAmounts.amountB), safeBalanceB);

  assert.strictEqual(amountA, '1900000', 'caps to safeBalance when gas was deducted');
  assert.strictEqual(amountB, '3800000', 'caps to safeBalance when gas was deducted');
  console.log('✔ gas deducted → caps to safeBalance (no regression)');
}

console.log('\nAll zapin balance-race-condition tests passed ✅');
