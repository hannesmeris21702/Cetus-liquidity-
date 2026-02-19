/**
 * Test for fix_amount_a selection logic when adding liquidity
 * 
 * This tests the logic that determines which token to fix when calling the SDK's
 * addLiquidityFixToken method. The correct choice is critical for in-range positions.
 * 
 * Run with: npx ts-node tests/fixAmountSelection.test.ts
 */

import assert from 'assert';

/**
 * Simulates the fix_amount_a selection logic from rebalance.ts
 */
function selectFixAmountA(
  amountA: string,
  amountB: string,
  priceIsInRange: boolean
): boolean {
  if (priceIsInRange && BigInt(amountA) > 0n && BigInt(amountB) > 0n) {
    // In-range position with both tokens: fix the smaller amount
    return BigInt(amountA) <= BigInt(amountB);
  } else {
    // Out-of-range position or one token is 0: fix the larger/non-zero amount
    return BigInt(amountA) >= BigInt(amountB);
  }
}

console.log('Running fix_amount_a selection tests...\n');

// Test 1: Out-of-range position below price (only token A needed)
{
  const fixAmountA = selectFixAmountA('1000', '0', false);
  assert.strictEqual(fixAmountA, true, 'Should fix token A when only A is available');
  console.log('✔ Out-of-range below: fixes token A when amountB=0');
}

// Test 2: Out-of-range position above price (only token B needed)
{
  const fixAmountA = selectFixAmountA('0', '2000', false);
  assert.strictEqual(fixAmountA, false, 'Should fix token B when only B is available');
  console.log('✔ Out-of-range above: fixes token B when amountA=0');
}

// Test 3: In-range position with both tokens - A is smaller
{
  const fixAmountA = selectFixAmountA('500', '1000', true);
  assert.strictEqual(
    fixAmountA,
    true,
    'In-range: should fix token A when it is the smaller amount'
  );
  console.log('✔ In-range: fixes smaller amount (A) when A < B');
}

// Test 4: In-range position with both tokens - B is smaller
{
  const fixAmountA = selectFixAmountA('1500', '800', true);
  assert.strictEqual(
    fixAmountA,
    false,
    'In-range: should fix token B when it is the smaller amount'
  );
  console.log('✔ In-range: fixes smaller amount (B) when B < A');
}

// Test 5: In-range position with equal amounts
{
  const fixAmountA = selectFixAmountA('1000', '1000', true);
  assert.strictEqual(
    fixAmountA,
    true,
    'In-range: should fix token A when amounts are equal (A <= B)'
  );
  console.log('✔ In-range: fixes token A when amounts are equal');
}

// Test 6: Edge case - in-range but one token is 0 (shouldn't happen after swaps, but test defensive logic)
{
  const fixAmountA = selectFixAmountA('1000', '0', true);
  assert.strictEqual(
    fixAmountA,
    true,
    'In-range with one token zero: should fix the non-zero token'
  );
  console.log('✔ In-range with amountB=0: fixes non-zero token A');
}

// Test 7: Edge case - in-range but the other token is 0
{
  const fixAmountA = selectFixAmountA('0', '2000', true);
  assert.strictEqual(
    fixAmountA,
    false,
    'In-range with one token zero: should fix the non-zero token'
  );
  console.log('✔ In-range with amountA=0: fixes non-zero token B');
}

// Test 8: Out-of-range with both tokens (edge case after swap)
{
  const fixAmountA = selectFixAmountA('800', '1200', false);
  assert.strictEqual(
    fixAmountA,
    false,
    'Out-of-range: should fix larger amount (B) even when both are present'
  );
  console.log('✔ Out-of-range with both tokens: fixes larger amount');
}

// Test 9: Realistic scenario - in-range after B→A swap
{
  // After swapping half of token B to get token A
  // We might have amountA=400, amountB=600
  const fixAmountA = selectFixAmountA('400', '600', true);
  assert.strictEqual(
    fixAmountA,
    true,
    'In-range after swap: should fix smaller amount A'
  );
  console.log('✔ In-range after B→A swap: fixes smaller amount (A)');
}

// Test 10: Realistic scenario - in-range after A→B swap
{
  // After swapping half of token A to get token B
  // We might have amountA=700, amountB=300
  const fixAmountA = selectFixAmountA('700', '300', true);
  assert.strictEqual(
    fixAmountA,
    false,
    'In-range after swap: should fix smaller amount B'
  );
  console.log('✔ In-range after A→B swap: fixes smaller amount (B)');
}

// Test 11: Very large amounts (test BigInt handling)
{
  const largeA = '1000000000000000000'; // 1 quintillion
  const largeB = '2000000000000000000'; // 2 quintillion
  const fixAmountA = selectFixAmountA(largeA, largeB, true);
  assert.strictEqual(
    fixAmountA,
    true,
    'Should handle very large amounts correctly'
  );
  console.log('✔ Handles very large amounts correctly');
}

// Test 12: Small amounts
{
  const fixAmountA = selectFixAmountA('1', '2', true);
  assert.strictEqual(fixAmountA, true, 'Should handle small amounts correctly');
  console.log('✔ Handles small amounts correctly');
}

console.log('\n=== Key Fix Validation ===');
console.log('OLD BEHAVIOR (line 1254): const fixAmountA = BigInt(amountA) >= BigInt(amountB)');
console.log('  - For in-range with amountA=600, amountB=400: would fix A (larger)');
console.log('  - Problem: SDK calculates required B, might exceed available 400');
console.log('');
console.log('NEW BEHAVIOR: Fix smaller amount for in-range positions');
console.log('  - For in-range with amountA=600, amountB=400: fixes B (smaller)');
console.log('  - Benefit: SDK calculates required A, likely ≤ available 600');
console.log('  - Result: Both tokens utilized, maximizing liquidity provision');
console.log('');

// Demonstrate the fix with a concrete example
{
  console.log('=== Concrete Example ===');
  const amountA = '600';
  const amountB = '400';
  const priceIsInRange = true;

  // Old behavior
  const oldFixAmountA = BigInt(amountA) >= BigInt(amountB);
  console.log(`Old logic: fixAmountA=${oldFixAmountA} (fix larger: A)`);
  console.log('  → SDK fixes 600 A, calculates required B');
  console.log('  → If required B > 400, transaction might fail or use partial amounts');

  // New behavior
  const newFixAmountA = selectFixAmountA(amountA, amountB, priceIsInRange);
  console.log(`New logic: fixAmountA=${newFixAmountA} (fix smaller: B)`);
  console.log('  → SDK fixes 400 B, calculates required A');
  console.log('  → Required A likely ≤ 600, both tokens fully utilized ✓');
  console.log('');

  assert.strictEqual(oldFixAmountA, true, 'Old behavior would fix A');
  assert.strictEqual(newFixAmountA, false, 'New behavior fixes B (smaller)');
}

console.log('\nAll fix_amount_a selection tests passed ✅');
