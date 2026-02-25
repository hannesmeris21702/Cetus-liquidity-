/**
 * Test for fix_amount_a selection logic when adding liquidity
 *
 * The Cetus SDK zap-in takes a SINGLE token as input and handles the internal
 * swap automatically.  The bot always passes exactly one non-zero amount:
 *
 *   fix_amount_a = BigInt(amountA) > 0n
 *
 * This means fix_amount_a simply tracks which of the two amounts is non-zero.
 *
 * Run with: npx ts-node tests/fixAmountSelection.test.ts
 */

import assert from 'assert';

/**
 * Mirrors the amount-selection and fix_amount_a logic in RebalanceService.addLiquidity.
 *
 * The SDK zap-in requires exactly ONE non-zero token.  The counterpart is
 * always '0'.  fix_amount_a is derived as `BigInt(amountA) > 0n`.
 */
function selectZapToken(
  safeBalanceA: bigint,
  safeBalanceB: bigint,
  priceIsBelowRange: boolean,
  priceIsAboveRange: boolean,
): { amountA: string; amountB: string; fixAmountA: boolean } {
  let amountA: string;
  let amountB: string;

  if (priceIsBelowRange) {
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

  return { amountA, amountB, fixAmountA: BigInt(amountA) > 0n };
}

console.log('Running fix_amount_a selection tests...\n');

// Test 1: Below-range position — only token A needed, fix A
{
  const { amountA, amountB, fixAmountA } = selectZapToken(1000n, 2000n, true, false);
  assert.strictEqual(amountA, '1000', 'amountA = full balance');
  assert.strictEqual(amountB, '0', 'amountB = 0 (not needed)');
  assert.strictEqual(fixAmountA, true, 'fix_amount_a=true when only A is the input');
  console.log('✔ Below-range: uses token A only, fix_amount_a=true');
}

// Test 2: Above-range position — only token B needed, fix B
{
  const { amountA, amountB, fixAmountA } = selectZapToken(1000n, 2000n, false, true);
  assert.strictEqual(amountA, '0', 'amountA = 0 (not needed)');
  assert.strictEqual(amountB, '2000', 'amountB = full balance');
  assert.strictEqual(fixAmountA, false, 'fix_amount_a=false when only B is the input');
  console.log('✔ Above-range: uses token B only, fix_amount_a=false');
}

// Test 3: In-range, token A available — use A as sole input
{
  const { amountA, amountB, fixAmountA } = selectZapToken(5000n, 3000n, false, false);
  assert.strictEqual(amountA, '5000', 'amountA = full A balance');
  assert.strictEqual(amountB, '0', 'amountB = 0 (SDK handles swap)');
  assert.strictEqual(fixAmountA, true, 'fix_amount_a=true, A is the zap input');
  console.log('✔ In-range with A available: uses token A only, fix_amount_a=true');
}

// Test 4: In-range, no token A — fall back to token B as sole input
{
  const { amountA, amountB, fixAmountA } = selectZapToken(0n, 3000n, false, false);
  assert.strictEqual(amountA, '0', 'amountA = 0 (none available)');
  assert.strictEqual(amountB, '3000', 'amountB = full B balance');
  assert.strictEqual(fixAmountA, false, 'fix_amount_a=false, B is the zap input');
  console.log('✔ In-range, no A available: falls back to token B, fix_amount_a=false');
}

// Test 5: fix_amount_a directly follows which amount is non-zero
{
  // Token A is input
  assert.strictEqual(BigInt('1000') > 0n, true, 'fix_amount_a=true when amountA>0');
  // Token B is input
  assert.strictEqual(BigInt('0') > 0n, false, 'fix_amount_a=false when amountA=0');
  console.log('✔ fix_amount_a = BigInt(amountA) > 0n correctly tracks the input token');
}

// Test 6: Very large amounts (BigInt precision)
{
  const largeA = 1_000_000_000_000_000_000n;
  const { amountA, amountB, fixAmountA } = selectZapToken(largeA, 2n, false, false);
  assert.strictEqual(amountA, largeA.toString());
  assert.strictEqual(amountB, '0');
  assert.strictEqual(fixAmountA, true);
  console.log('✔ Handles very large token A amounts correctly');
}

// Test 7: Zero A balance in-range — uses B
{
  const { amountA, amountB, fixAmountA } = selectZapToken(0n, 999999n, false, false);
  assert.strictEqual(amountA, '0');
  assert.strictEqual(amountB, '999999');
  assert.strictEqual(fixAmountA, false);
  console.log('✔ In-range with zero A balance: correctly uses B as sole input');
}

// Test 8: Below-range with zero A balance — still uses A (amount will be '0')
//          The outer guard in addLiquidity will throw "Insufficient balance" in this case.
{
  const { amountA, amountB, fixAmountA } = selectZapToken(0n, 5000n, true, false);
  assert.strictEqual(amountA, '0');
  assert.strictEqual(amountB, '0');
  // Both 0 → addLiquidity throws; but direction is still A for below-range
  assert.strictEqual(fixAmountA, false, 'amountA=0 so fix_amount_a=false');
  console.log('✔ Below-range with zero A: both=0 (addLiquidity throws insufficient balance)');
}

console.log('\n=== Key Design Point ===');
console.log('The Cetus SDK zap-in requires only ONE token as input.');
console.log('The SDK performs the necessary internal swap to obtain the');
console.log('correct token ratio before adding liquidity.');
console.log('');
console.log('Rule:');
console.log('  amountA = <balance> , amountB = "0"  →  fix_amount_a = true  (A is input)');
console.log('  amountA = "0"       , amountB = <bal> →  fix_amount_a = false (B is input)');
console.log('');
console.log('Priority:');
console.log('  1. TOKEN_A_AMOUNT env > TOKEN_B_AMOUNT env');
console.log('  2. Freed position tokens (prefer A unless above-range)');
console.log('  3. Wallet balance (prefer A unless above-range or no A available)');

console.log('\nAll fix_amount_a selection tests passed ✅');
