import assert from 'assert';

/**
 * Tests for the swap detection logic in the addLiquidity flow.
 *
 * When one token has zero balance after removing an out-of-range position,
 * the bot must swap approximately half of the available token to obtain
 * both tokens before adding liquidity to an in-range position.
 *
 * Run with:  npx ts-node tests/swapDetection.test.ts
 */

// ---------- Pure reimplementation of the swap-detection logic ----------
// Extracted from the new block in RebalanceService.addLiquidity.

interface SwapDecision {
  needsSwap: boolean;
  aToB?: boolean;
  swapAmount?: string;
}

function detectSwapNeeded(amountA: string, amountB: string): SwapDecision {
  const preSwapA = BigInt(amountA);
  const preSwapB = BigInt(amountB);
  const oneIsZero =
    (preSwapA === 0n && preSwapB > 0n) ||
    (preSwapA > 0n && preSwapB === 0n);

  if (!oneIsZero) {
    return { needsSwap: false };
  }

  const hasOnlyA = preSwapA > 0n;
  const swapAmount = (hasOnlyA ? preSwapA : preSwapB) / 2n;

  if (swapAmount === 0n) {
    return { needsSwap: false };
  }

  return {
    needsSwap: true,
    aToB: hasOnlyA,
    swapAmount: swapAmount.toString(),
  };
}

// ---------- Tests --------------------------------------------------------

// 1. Both tokens non-zero → no swap needed
{
  const r = detectSwapNeeded('5000', '3000');
  assert.strictEqual(r.needsSwap, false);
  console.log('✔ both tokens non-zero → no swap');
}

// 2. Only token A available → swap A→B with half of A
{
  const r = detectSwapNeeded('10000', '0');
  assert.strictEqual(r.needsSwap, true);
  assert.strictEqual(r.aToB, true, 'should swap A→B');
  assert.strictEqual(r.swapAmount, '5000', 'should swap half');
  console.log('✔ only token A → swap A→B (half)');
}

// 3. Only token B available → swap B→A with half of B
{
  const r = detectSwapNeeded('0', '8000');
  assert.strictEqual(r.needsSwap, true);
  assert.strictEqual(r.aToB, false, 'should swap B→A');
  assert.strictEqual(r.swapAmount, '4000', 'should swap half');
  console.log('✔ only token B → swap B→A (half)');
}

// 4. Both tokens zero → no swap possible
{
  const r = detectSwapNeeded('0', '0');
  assert.strictEqual(r.needsSwap, false);
  console.log('✔ both tokens zero → no swap');
}

// 5. Token A is 1 (minimum) → swap amount rounds to 0 → no swap
{
  const r = detectSwapNeeded('1', '0');
  assert.strictEqual(r.needsSwap, false, 'amount too small for meaningful swap');
  console.log('✔ amount 1 rounds to 0 → no swap');
}

// 6. Token B is 1 (minimum) → same rounding
{
  const r = detectSwapNeeded('0', '1');
  assert.strictEqual(r.needsSwap, false, 'amount too small for meaningful swap');
  console.log('✔ amount 1 (token B) rounds to 0 → no swap');
}

// 7. Large amounts (mainnet-scale) → swap works correctly
{
  const r = detectSwapNeeded('4100000000', '0'); // ~4.1 SUI
  assert.strictEqual(r.needsSwap, true);
  assert.strictEqual(r.aToB, true);
  assert.strictEqual(r.swapAmount, '2050000000', 'half of 4.1 SUI');
  console.log('✔ large mainnet-scale amount → correct swap amount');
}

// 8. Odd amount → integer division truncates (not rounds)
{
  const r = detectSwapNeeded('0', '999');
  assert.strictEqual(r.needsSwap, true);
  assert.strictEqual(r.aToB, false);
  assert.strictEqual(r.swapAmount, '499', 'integer division 999/2 = 499');
  console.log('✔ odd amount → integer division truncates');
}

console.log('\nAll swapDetection tests passed ✅');
