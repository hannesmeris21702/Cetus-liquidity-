import assert from 'assert';

/**
 * Tests for the rebalance amount calculation logic.
 *
 * The addLiquidity helper chooses a SINGLE token for the zap-in call:
 *
 *   • If freed A is positive and the price is not above range → use freed A
 *     (capped to safe wallet balance), set B = 0.
 *   • If freed B is positive (or above-range) → use freed B
 *     (capped to safe wallet balance), set A = 0.
 *   • If both freed amounts are 0 → fall back to the matching wallet balance
 *     (still single-token: prefer A unless above-range or A=0).
 *   • Safe wallet balance = wallet balance − gas reserve when token is SUI.
 *
 * The Cetus SDK zap-in handles the swap internally.  No dual-token input is
 * needed; always pass exactly one non-zero amount.
 *
 * Run with:  npx ts-node tests/rebalanceAmounts.test.ts
 */

// ---------- Pure reimplementation of the single-token amount-selection logic ----------
// Extracted from RebalanceService.addLiquidity so we can test it without
// instantiating the full service / SDK.

function computeZapInput(
  removedAmountA: string | undefined,
  removedAmountB: string | undefined,
  walletBalanceA: string,
  walletBalanceB: string,
  priceIsAboveRange: boolean = false,
  isSuiA: boolean = false,
  isSuiB: boolean = false,
  gasBudget: bigint = 100_000_000n,
): { amountA: string; amountB: string } {
  const rawBalA = BigInt(walletBalanceA);
  const rawBalB = BigInt(walletBalanceB);
  const safeBalanceA = isSuiA && rawBalA > gasBudget ? rawBalA - gasBudget : rawBalA;
  const safeBalanceB = isSuiB && rawBalB > gasBudget ? rawBalB - gasBudget : rawBalB;

  const removedA = removedAmountA ? BigInt(removedAmountA) : 0n;
  const removedB = removedAmountB ? BigInt(removedAmountB) : 0n;

  if (removedA > 0n || removedB > 0n) {
    // Pick the single token the position range requires.
    // Below-range or in-range: prefer A. Above-range or no freed A: use B.
    if (!priceIsAboveRange && removedA > 0n) {
      const amt = removedA <= safeBalanceA ? removedA : safeBalanceA;
      return { amountA: amt.toString(), amountB: '0' };
    } else {
      const amt = removedB > 0n
        ? (removedB <= safeBalanceB ? removedB : safeBalanceB)
        : safeBalanceB;
      return { amountA: '0', amountB: amt.toString() };
    }
  }

  // Both freed amounts are 0 — fall back to wallet balance (single-token).
  if (!priceIsAboveRange && safeBalanceA > 0n) {
    return { amountA: safeBalanceA.toString(), amountB: '0' };
  }
  return { amountA: '0', amountB: safeBalanceB.toString() };
}

// ---------- Tests --------------------------------------------------------

// 1. Freed A present, in-range → use freed A only, B=0
{
  const { amountA, amountB } = computeZapInput('500', '300', '1000', '1000');
  assert.strictEqual(amountA, '500', 'freed A used as single zap input');
  assert.strictEqual(amountB, '0', 'B must be 0 (single-token zap)');
  console.log('✔ freed A (in-range): uses freed A only, B=0');
}

// 2. Only B freed, in-range → use freed B only
{
  const { amountA, amountB } = computeZapInput(undefined, '5000', '1200', '6000');
  assert.strictEqual(amountA, '0', 'no freed A → A=0');
  assert.strictEqual(amountB, '5000', 'freed B used as single zap input');
  console.log('✔ only freed B (in-range): uses freed B only');
}

// 3. Only A freed, in-range → use freed A only
{
  const { amountA, amountB } = computeZapInput('7000', undefined, '8000', '3000');
  assert.strictEqual(amountA, '7000', 'freed A used as zap input');
  assert.strictEqual(amountB, '0', 'no freed B → B=0');
  console.log('✔ only freed A (in-range): uses freed A only');
}

// 4. Freed A exceeds wallet balance → cap to wallet balance
{
  const { amountA, amountB } = computeZapInput('1000', '500', '800', '500');
  assert.strictEqual(amountA, '800', 'freed A capped to wallet balance');
  assert.strictEqual(amountB, '0');
  console.log('✔ freed A capped at wallet balance, B=0');
}

// 5. Both freed amounts 0, in-range, A available → wallet A
{
  const { amountA, amountB } = computeZapInput(undefined, undefined, '400', '600');
  assert.strictEqual(amountA, '400', 'fallback to wallet A');
  assert.strictEqual(amountB, '0');
  console.log('✔ both freed=0, in-range, A available → wallet A');
}

// 6. Both freed amounts 0, wallet A=0 → wallet B
{
  const { amountA, amountB } = computeZapInput(undefined, '2000', '0', '3000');
  assert.strictEqual(amountA, '0');
  assert.strictEqual(amountB, '2000', 'freed B used when no freed A');
  console.log('✔ no freed A, freed B available → freed B');
}

// 7. Freed A present but above-range → use freed B (or wallet B)
{
  const { amountA, amountB } = computeZapInput('500', '300', '1000', '1000', true);
  assert.strictEqual(amountA, '0', 'above-range: A must be 0');
  assert.strictEqual(amountB, '300', 'above-range: uses freed B');
  console.log('✔ freed both (above-range): uses freed B only');
}

// 8. Above-range, only freed A (no freed B) → uses wallet B
{
  const { amountA, amountB } = computeZapInput('7000', undefined, '8000', '3000', true);
  assert.strictEqual(amountA, '0', 'above-range: A must be 0');
  assert.strictEqual(amountB, '3000', 'above-range, no freed B: uses wallet B');
  console.log('✔ above-range, only freed A → falls back to wallet B');
}

// 9. SUI gas reserve: freed SUI A amount within safe balance → exact freed amount
{
  // Freed 3.0 SUI, wallet 4.2 SUI, gas=0.1 SUI → safe=4.1 SUI; 3.0 < 4.1 → use 3.0
  const { amountA, amountB } = computeZapInput(
    '3000000000', '5000000000', '4200000000', '6000000000',
    false, true, false, 100_000_000n,
  );
  assert.strictEqual(amountA, '3000000000', 'freed SUI within safe balance → exact');
  assert.strictEqual(amountB, '0');
  console.log('✔ freed SUI A within safe balance → used exactly');
}

// 10. SUI gas reserve: freed SUI A exceeds safe balance → capped
{
  // Freed 4.15 SUI, wallet 4.2 SUI, gas=0.1 SUI → safe=4.1 SUI; 4.15 > 4.1 → cap to 4.1
  const { amountA, amountB } = computeZapInput(
    '4150000000', '5000000000', '4200000000', '6000000000',
    false, true, false, 100_000_000n,
  );
  assert.strictEqual(amountA, '4100000000', 'freed SUI capped to safe balance');
  assert.strictEqual(amountB, '0');
  console.log('✔ freed SUI A exceeds safe balance → capped to safe balance');
}

// 11. Same-liquidity guarantee: when freed A is provided it is used exactly (not more from wallet)
{
  // Freed only 2000 A, wallet has 1M A — must NOT use wallet
  const { amountA, amountB } = computeZapInput('2000', undefined, '1000000', '2000000');
  assert.strictEqual(amountA, '2000', 'must re-add exactly what was freed for A');
  assert.strictEqual(amountB, '0');
  console.log('✔ same-liquidity: uses exactly freed A, not full wallet balance');
}

// 12. Both freed=0, above-range → wallet B
{
  const { amountA, amountB } = computeZapInput(undefined, undefined, '400', '600', true);
  assert.strictEqual(amountA, '0', 'above-range: A must be 0');
  assert.strictEqual(amountB, '600', 'above-range fallback: wallet B');
  console.log('✔ both freed=0, above-range → wallet B');
}

console.log('\nAll rebalanceAmounts tests passed ✅');
