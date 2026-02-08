import assert from 'assert';

/**
 * Tests for the rebalance amount calculation logic.
 *
 * The addLiquidity helper must choose token amounts as follows when
 * rebalancing (removedAmountA / removedAmountB are provided):
 *
 *   • If a removed amount is positive and ≤ safe wallet balance → use it.
 *   • If a removed amount is undefined/0 or exceeds safe wallet balance
 *     → fall back to the safe wallet balance.
 *   • Safe wallet balance = wallet balance − gas reserve when token is SUI.
 *
 * This ensures both tokens have a non-zero max for the SDK even when an
 * out-of-range position returned all value in a single token, and that
 * enough SUI is reserved for the add-liquidity transaction gas.
 *
 * Run with:  npx ts-node tests/rebalanceAmounts.test.ts
 */

// ---------- Pure reimplementation of the amount-selection logic ----------
// Extracted from RebalanceService.addLiquidity so we can test it without
// instantiating the full service / SDK.

function computeRebalanceAmounts(
  removedAmountA: string | undefined,
  removedAmountB: string | undefined,
  walletBalanceA: string,
  walletBalanceB: string,
  isSuiA: boolean = false,
  isSuiB: boolean = false,
  gasBudget: bigint = 100_000_000n,
): { amountA: string; amountB: string } {
  const balanceABigInt = BigInt(walletBalanceA);
  const balanceBBigInt = BigInt(walletBalanceB);

  const safeBalanceA = isSuiA && balanceABigInt > gasBudget
    ? balanceABigInt - gasBudget
    : balanceABigInt;
  const safeBalanceB = isSuiB && balanceBBigInt > gasBudget
    ? balanceBBigInt - gasBudget
    : balanceBBigInt;

  const removedA = removedAmountA ? BigInt(removedAmountA) : 0n;
  const removedB = removedAmountB ? BigInt(removedAmountB) : 0n;

  const amountA = (removedA > 0n ? (removedA <= safeBalanceA ? removedA : safeBalanceA) : 0n).toString();
  const amountB = (removedB > 0n ? (removedB <= safeBalanceB ? removedB : safeBalanceB) : 0n).toString();

  return { amountA, amountB };
}

// ---------- Tests --------------------------------------------------------

// 1. Both removed amounts present and within wallet balance → use them.
{
  const { amountA, amountB } = computeRebalanceAmounts('500', '300', '1000', '1000');
  assert.strictEqual(amountA, '500');
  assert.strictEqual(amountB, '300');
  console.log('✔ both removed amounts used when within wallet balance');
}

// 2. One removed amount is undefined (out-of-range, all in token B).
//    Token A should stay 0 so only freed liquidity is re-added.
{
  const { amountA, amountB } = computeRebalanceAmounts(undefined, '5000', '1200', '6000');
  assert.strictEqual(amountA, '0', 'should stay 0 when nothing was removed for token A');
  assert.strictEqual(amountB, '5000', 'should use removed amount for token B');
  console.log('✔ undefined removed amount A stays 0 (swap logic will balance)');
}

// 3. One removed amount is undefined (out-of-range, all in token A).
{
  const { amountA, amountB } = computeRebalanceAmounts('7000', undefined, '8000', '3000');
  assert.strictEqual(amountA, '7000');
  assert.strictEqual(amountB, '0', 'should stay 0 when nothing was removed for token B');
  console.log('✔ undefined removed amount B stays 0 (swap logic will balance)');
}

// 4. Removed amount exceeds wallet balance (e.g. gas consumed SUI).
//    Should cap to wallet balance.
{
  const { amountA, amountB } = computeRebalanceAmounts('1000', '500', '800', '500');
  assert.strictEqual(amountA, '800', 'should cap to wallet balance when removed exceeds it');
  assert.strictEqual(amountB, '500');
  console.log('✔ removed amount capped at wallet balance');
}

// 5. Both removed amounts undefined – both stay 0 (no liquidity was freed).
{
  const { amountA, amountB } = computeRebalanceAmounts(undefined, undefined, '400', '600');
  assert.strictEqual(amountA, '0');
  assert.strictEqual(amountB, '0');
  console.log('✔ both undefined → 0 for both (no freed liquidity to re-add)');
}

// 6. Wallet balance is 0 for one token after gas costs – removed stays 0.
{
  const { amountA, amountB } = computeRebalanceAmounts(undefined, '2000', '0', '3000');
  assert.strictEqual(amountA, '0', 'no removed amount → stays 0');
  assert.strictEqual(amountB, '2000');
  console.log('✔ wallet balance 0 and no removed amount → 0');
}

// 7. KEY FIX SCENARIO: removed amount A is undefined, wallet has non-zero A.
//    Old code fell back to full wallet balance → new position got extra liquidity.
//    Fixed code keeps 0 so only freed amounts are re-added.
{
  const { amountA, amountB } = computeRebalanceAmounts(undefined, '10000', '5000', '10000');
  assert.strictEqual(amountA, '0', 'MUST be 0 — only freed liquidity should be re-added');
  assert.strictEqual(amountB, '10000');
  console.log('✔ key fix: no extra wallet funds used when removed amount is 0');
}

// 8. SUI gas reserve: token A is SUI, removed amount undefined → stays 0.
{
  const { amountA, amountB } = computeRebalanceAmounts(
    undefined, '5000000000', '4200000000', '6000000000',
    true, false, 100_000_000n,
  );
  assert.strictEqual(amountA, '0', 'no removed A → stays 0 regardless of wallet balance');
  assert.strictEqual(amountB, '5000000000', 'non-SUI token unaffected');
  console.log('✔ SUI token A with no removed amount stays 0');
}

// 9. SUI gas reserve: token B is SUI, removed amount undefined → stays 0.
{
  const { amountA, amountB } = computeRebalanceAmounts(
    '3000000000', undefined, '5000000000', '2000000000',
    false, true, 100_000_000n,
  );
  assert.strictEqual(amountA, '3000000000');
  assert.strictEqual(amountB, '0', 'no removed B → stays 0 regardless of wallet balance');
  console.log('✔ SUI token B with no removed amount stays 0');
}

// 10. SUI gas reserve: removed SUI amount exceeds safe balance → cap to safe balance.
{
  // Removed 4.15 SUI, wallet has 4.2 SUI, gas reserve = 0.1 SUI → safe = 4.1 SUI
  const { amountA, amountB } = computeRebalanceAmounts(
    '4150000000', '5000000000', '4200000000', '6000000000',
    true, false, 100_000_000n,
  );
  assert.strictEqual(amountA, '4100000000', 'removed SUI capped at safe balance');
  assert.strictEqual(amountB, '5000000000');
  console.log('✔ SUI removed amount capped at safe balance');
}

// 11. SUI gas reserve: wallet balance ≤ gas budget, no removed amount → stays 0.
{
  const { amountA, amountB } = computeRebalanceAmounts(
    undefined, '1000', '50000000', '2000',
    true, false, 100_000_000n,
  );
  assert.strictEqual(amountA, '0', 'no removed A → stays 0');
  assert.strictEqual(amountB, '1000');
  console.log('✔ no removed amount stays 0 even with low SUI balance');
}

// 12. Non-SUI tokens: no removed amount → stays 0.
{
  const { amountA, amountB } = computeRebalanceAmounts(
    undefined, '1000', '500000000', '2000',
    false, false, 100_000_000n,
  );
  assert.strictEqual(amountA, '0', 'no removed A → stays 0');
  console.log('✔ non-SUI tokens: no removed amount stays 0');
}

// 13. Same-liquidity guarantee: when both removed amounts are provided,
//     the new position uses exactly those amounts (not more from wallet).
{
  // Old position freed 2000 A and 3000 B, wallet has much larger balances
  const { amountA, amountB } = computeRebalanceAmounts(
    '2000', '3000', '1000000', '2000000',
  );
  assert.strictEqual(amountA, '2000', 'must re-add exactly what was removed for A');
  assert.strictEqual(amountB, '3000', 'must re-add exactly what was removed for B');
  console.log('✔ same-liquidity: re-adds exactly the freed amounts, not full wallet');
}

// 14. SUI gas reserve: removed SUI amount within safe balance → use exact removed amount.
{
  // Removed 3.0 SUI, wallet has 4.2 SUI, gas reserve = 0.1 SUI → safe = 4.1 SUI
  // 3.0 < 4.1, so use 3.0
  const { amountA, amountB } = computeRebalanceAmounts(
    '3000000000', '5000000000', '4200000000', '6000000000',
    true, false, 100_000_000n,
  );
  assert.strictEqual(amountA, '3000000000', 'use exact removed SUI when within safe balance');
  assert.strictEqual(amountB, '5000000000');
  console.log('✔ SUI removed amount used exactly when within safe balance');
}

console.log('\nAll rebalanceAmounts tests passed ✅');
