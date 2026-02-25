/**
 * Tests for the single-token zap-in logic.
 *
 * The Cetus SDK zap-in requires only ONE token as input.  The SDK internally
 * performs the necessary swap and adds liquidity to the position.
 *
 * This test verifies:
 * 1. The correct single token is selected based on position range and available
 *    balances.
 * 2. fix_amount_a is always derived as `BigInt(amountA) > 0n`.
 * 3. The counterpart token is always set to '0'.
 * 4. Env-var token amounts take priority and are passed as-is (single-sided).
 * 5. Freed tokens from a closed position are correctly filtered to one token.
 *
 * Run with: npx ts-node tests/zapInOptimalSwap.test.ts
 */

import assert from 'assert';

// ---------------------------------------------------------------------------
// Reimplementation of the single-token amount-selection logic
// (mirrors RebalanceService.addLiquidity)
// ---------------------------------------------------------------------------

function calculateZapAmount(removedAmount: bigint, safeBalance: bigint): string {
  if (removedAmount <= 0n) return '0';
  if (safeBalance === 0n) return removedAmount.toString();
  return (removedAmount <= safeBalance ? removedAmount : safeBalance).toString();
}

interface ZapParams {
  amountA: string;
  amountB: string;
  fixAmountA: boolean;
}

function selectZapParams(opts: {
  safeBalanceA: bigint;
  safeBalanceB: bigint;
  priceIsBelowRange: boolean;
  priceIsAboveRange: boolean;
  envAmountA?: string;
  envAmountB?: string;
  closedPositionAmounts?: { amountA: string; amountB: string };
}): ZapParams {
  const {
    safeBalanceA, safeBalanceB,
    priceIsBelowRange, priceIsAboveRange,
    envAmountA, envAmountB,
    closedPositionAmounts,
  } = opts;

  let amountA: string;
  let amountB: string;

  if (envAmountA) {
    amountA = envAmountA;
    amountB = '0';
  } else if (envAmountB) {
    amountA = '0';
    amountB = envAmountB;
  } else if (closedPositionAmounts) {
    const removedA = BigInt(closedPositionAmounts.amountA);
    const removedB = BigInt(closedPositionAmounts.amountB);
    if (removedA > 0n || removedB > 0n) {
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
    if (safeBalanceA > 0n) {
      amountA = safeBalanceA.toString();
      amountB = '0';
    } else {
      amountA = '0';
      amountB = safeBalanceB.toString();
    }
  }

  return { amountA, amountB, fixAmountA: BigInt(amountA) > 0n };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('Running single-token zap-in tests...\n');

// ── Basic range-based selection ─────────────────────────────────────────────

// 1. Below-range: use token A, SDK swaps as needed
{
  const p = selectZapParams({ safeBalanceA: 5_000_000n, safeBalanceB: 3_000_000n, priceIsBelowRange: true, priceIsAboveRange: false });
  assert.strictEqual(p.amountA, '5000000', 'below-range: full A balance');
  assert.strictEqual(p.amountB, '0', 'below-range: B must be 0');
  assert.strictEqual(p.fixAmountA, true, 'below-range: fixAmountA=true');
  console.log('✔ Below-range: uses token A as sole zap input, SDK handles swap');
}

// 2. Above-range: use token B, SDK swaps as needed
{
  const p = selectZapParams({ safeBalanceA: 5_000_000n, safeBalanceB: 3_000_000n, priceIsBelowRange: false, priceIsAboveRange: true });
  assert.strictEqual(p.amountA, '0', 'above-range: A must be 0');
  assert.strictEqual(p.amountB, '3000000', 'above-range: full B balance');
  assert.strictEqual(p.fixAmountA, false, 'above-range: fixAmountA=false');
  console.log('✔ Above-range: uses token B as sole zap input, SDK handles swap');
}

// 3. In-range with token A available: use A, SDK handles swap to correct ratio
{
  const p = selectZapParams({ safeBalanceA: 8_000_000n, safeBalanceB: 4_000_000n, priceIsBelowRange: false, priceIsAboveRange: false });
  assert.strictEqual(p.amountA, '8000000', 'in-range: prefers A when available');
  assert.strictEqual(p.amountB, '0', 'in-range: B must be 0 (single-token)');
  assert.strictEqual(p.fixAmountA, true, 'in-range: fixAmountA=true when A chosen');
  console.log('✔ In-range with A: uses A only, SDK calculates ratio and swaps internally');
}

// 4. In-range with no token A: fall back to B
{
  const p = selectZapParams({ safeBalanceA: 0n, safeBalanceB: 4_000_000n, priceIsBelowRange: false, priceIsAboveRange: false });
  assert.strictEqual(p.amountA, '0');
  assert.strictEqual(p.amountB, '4000000', 'in-range, no A: uses B');
  assert.strictEqual(p.fixAmountA, false);
  console.log('✔ In-range, no A: falls back to token B, SDK handles ratio');
}

// ── Env-var token amounts ────────────────────────────────────────────────────

// 5. TOKEN_A_AMOUNT env set: use it, ignore balance and range
{
  const p = selectZapParams({
    safeBalanceA: 9_000_000n, safeBalanceB: 9_000_000n,
    priceIsBelowRange: false, priceIsAboveRange: false,
    envAmountA: '2500000',
  });
  assert.strictEqual(p.amountA, '2500000');
  assert.strictEqual(p.amountB, '0');
  assert.strictEqual(p.fixAmountA, true);
  console.log('✔ TOKEN_A_AMOUNT env: used as sole input, B=0, SDK swaps internally');
}

// 6. TOKEN_B_AMOUNT env set: use it
{
  const p = selectZapParams({
    safeBalanceA: 9_000_000n, safeBalanceB: 9_000_000n,
    priceIsBelowRange: false, priceIsAboveRange: false,
    envAmountB: '1800000',
  });
  assert.strictEqual(p.amountA, '0');
  assert.strictEqual(p.amountB, '1800000');
  assert.strictEqual(p.fixAmountA, false);
  console.log('✔ TOKEN_B_AMOUNT env: used as sole input, A=0, SDK swaps internally');
}

// 7. Both env vars set: TOKEN_A_AMOUNT wins
{
  const p = selectZapParams({
    safeBalanceA: 9_000_000n, safeBalanceB: 9_000_000n,
    priceIsBelowRange: false, priceIsAboveRange: false,
    envAmountA: '3000000',
    envAmountB: '7000000',
  });
  assert.strictEqual(p.amountA, '3000000', 'A env takes priority');
  assert.strictEqual(p.amountB, '0');
  assert.strictEqual(p.fixAmountA, true);
  console.log('✔ Both env vars: TOKEN_A_AMOUNT takes priority');
}

// ── Freed position amounts (rebalancing) ────────────────────────────────────

// 8. Rebalancing (in-range new range): freed A available → use A
{
  const p = selectZapParams({
    safeBalanceA: 10_000_000n, safeBalanceB: 10_000_000n,
    priceIsBelowRange: false, priceIsAboveRange: false,
    closedPositionAmounts: { amountA: '5310014', amountB: '4200000' },
  });
  assert.strictEqual(p.amountA, '5310014', 'freed A used as zap input');
  assert.strictEqual(p.amountB, '0', 'B must be 0 (single-token)');
  assert.strictEqual(p.fixAmountA, true);
  console.log('✔ Rebalancing in-range: freed A used as sole input (SDK handles ratio swap)');
}

// 9. Rebalancing (above-range new range): freed B used
{
  const p = selectZapParams({
    safeBalanceA: 10_000_000n, safeBalanceB: 10_000_000n,
    priceIsBelowRange: false, priceIsAboveRange: true,
    closedPositionAmounts: { amountA: '5310014', amountB: '4200000' },
  });
  assert.strictEqual(p.amountA, '0');
  assert.strictEqual(p.amountB, '4200000', 'freed B used as zap input (above-range)');
  assert.strictEqual(p.fixAmountA, false);
  console.log('✔ Rebalancing above-range: freed B used as sole input');
}

// 10. Rebalancing: freed A=0, freed B > 0 → use B
{
  const p = selectZapParams({
    safeBalanceA: 10_000_000n, safeBalanceB: 10_000_000n,
    priceIsBelowRange: false, priceIsAboveRange: false,
    closedPositionAmounts: { amountA: '0', amountB: '5310014' },
  });
  assert.strictEqual(p.amountA, '0');
  assert.strictEqual(p.amountB, '5310014', 'only freed B available → use B');
  assert.strictEqual(p.fixAmountA, false);
  console.log('✔ Rebalancing: only freed B → uses B as sole zap input');
}

// 11. Rebalancing: freed A capped to safe wallet balance
{
  const p = selectZapParams({
    safeBalanceA: 4_000_000n, safeBalanceB: 10_000_000n,
    priceIsBelowRange: false, priceIsAboveRange: false,
    closedPositionAmounts: { amountA: '5000000', amountB: '3000000' },
  });
  // freed A=5M but wallet only has 4M → cap to 4M
  assert.strictEqual(p.amountA, '4000000', 'freed A capped to safe wallet balance');
  assert.strictEqual(p.amountB, '0');
  assert.strictEqual(p.fixAmountA, true);
  console.log('✔ Rebalancing: freed A capped to safe wallet balance');
}

// 12. Rebalancing: both freed=0 fallback (in-range) → A from wallet
{
  const p = selectZapParams({
    safeBalanceA: 6_000_000n, safeBalanceB: 4_000_000n,
    priceIsBelowRange: false, priceIsAboveRange: false,
    closedPositionAmounts: { amountA: '0', amountB: '0' },
  });
  assert.strictEqual(p.amountA, '6000000', 'fallback to wallet A');
  assert.strictEqual(p.amountB, '0');
  assert.strictEqual(p.fixAmountA, true);
  console.log('✔ Rebalancing: both freed=0 fallback → wallet A used as zap input');
}

// 13. Rebalancing: both freed=0, above-range → B from wallet
{
  const p = selectZapParams({
    safeBalanceA: 6_000_000n, safeBalanceB: 4_000_000n,
    priceIsBelowRange: false, priceIsAboveRange: true,
    closedPositionAmounts: { amountA: '0', amountB: '0' },
  });
  assert.strictEqual(p.amountA, '0');
  assert.strictEqual(p.amountB, '4000000', 'fallback to wallet B (above-range)');
  assert.strictEqual(p.fixAmountA, false);
  console.log('✔ Rebalancing: both freed=0, above-range fallback → wallet B used');
}

// ── fix_amount_a derivation ──────────────────────────────────────────────────

// 14. fix_amount_a always matches which amount is non-zero
{
  const cases: Array<[string, string, boolean]> = [
    ['1000', '0', true],
    ['0', '2000', false],
    ['999999', '0', true],
    ['0', '1', false],
  ];
  for (const [a, b, expected] of cases) {
    const fixA = BigInt(a) > 0n;
    assert.strictEqual(fixA, expected, `fix_amount_a for (${a},${b})`);
  }
  console.log('✔ fix_amount_a = BigInt(amountA) > 0n is always consistent with non-zero token');
}

console.log('\n=== Design Summary ===');
console.log('The Cetus SDK zap-in requires only ONE token as input:');
console.log('  - fix_amount_a=true  → amountA is the full zap input, amountB="0"');
console.log('  - fix_amount_a=false → amountB is the full zap input, amountA="0"');
console.log('The SDK internally swaps the correct portion and adds liquidity.');
console.log('No manual pre-swap or ratio calculation is needed in the bot.');

console.log('\nAll single-token zap-in tests passed ✅');
