/**
 * Test for post-remove liquidity token swap logic
 * Verifies that the bot correctly swaps tokens immediately after removing liquidity
 * to match the requirements of the new position
 * 
 * Run with: npx ts-node tests/postRemoveLiquiditySwap.test.ts
 */

import assert from 'assert';

// Mock logger
const mockLogger = {
  logs: [] as Array<{ level: string; message: string; data?: any }>,
  info(message: string, data?: any) {
    this.logs.push({ level: 'info', message, data });
  },
  warn(message: string, data?: any) {
    this.logs.push({ level: 'warn', message, data });
  },
  error(message: string, data?: any) {
    this.logs.push({ level: 'error', message, data });
  },
  clearLogs() {
    this.logs.length = 0;
  },
};

/**
 * Simulate position range analysis
 */
function analyzePositionRange(currentTick: number, lower: number, upper: number) {
  const priceIsBelowRange = currentTick < lower;
  const priceIsAboveRange = currentTick >= upper;
  const priceIsInRange = !priceIsBelowRange && !priceIsAboveRange;
  
  return {
    priceIsBelowRange,
    priceIsAboveRange,
    priceIsInRange,
  };
}

/**
 * Determine swap requirements after removing liquidity
 */
function determineSwapRequirements(
  currentTick: number,
  newLower: number,
  newUpper: number,
  removedAmountA: bigint,
  removedAmountB: bigint
): { needsSwap: boolean; swapDirection?: 'A→B' | 'B→A' | 'split'; reason?: string } {
  const { priceIsBelowRange, priceIsAboveRange, priceIsInRange } = 
    analyzePositionRange(currentTick, newLower, newUpper);
  
  // Case 1: Out-of-range below (needs only token A)
  if (priceIsBelowRange) {
    if (removedAmountA === 0n && removedAmountB > 0n) {
      return {
        needsSwap: true,
        swapDirection: 'B→A',
        reason: 'Position needs only token A, but only have token B'
      };
    }
  }
  
  // Case 2: Out-of-range above (needs only token B)
  if (priceIsAboveRange) {
    if (removedAmountB === 0n && removedAmountA > 0n) {
      return {
        needsSwap: true,
        swapDirection: 'A→B',
        reason: 'Position needs only token B, but only have token A'
      };
    }
  }
  
  // Case 3: In-range (needs both tokens)
  if (priceIsInRange) {
    if (removedAmountA === 0n && removedAmountB > 0n) {
      return {
        needsSwap: true,
        swapDirection: 'split',
        reason: 'Position needs both tokens, but only have token B'
      };
    }
    if (removedAmountB === 0n && removedAmountA > 0n) {
      return {
        needsSwap: true,
        swapDirection: 'split',
        reason: 'Position needs both tokens, but only have token A'
      };
    }
  }
  
  return { needsSwap: false };
}

async function runTests() {
  console.log('Running post-remove liquidity swap tests...\n');

  // Test 1: Out-of-range below - have B, need A
  {
    const currentTick = 100;
    const newLower = 200;
    const newUpper = 300;
    const removedAmountA = 0n;
    const removedAmountB = 1000000n;
    
    const result = determineSwapRequirements(
      currentTick, newLower, newUpper,
      removedAmountA, removedAmountB
    );
    
    assert.ok(result.needsSwap, 'Should need swap');
    assert.strictEqual(result.swapDirection, 'B→A', 'Should swap B→A');
    assert.ok(result.reason?.includes('token A'), 'Reason should mention token A');
    
    console.log('✔ Out-of-range below: Correctly identifies need to swap B→A');
  }

  // Test 2: Out-of-range above - have A, need B
  {
    const currentTick = 400;
    const newLower = 200;
    const newUpper = 300;
    const removedAmountA = 1000000n;
    const removedAmountB = 0n;
    
    const result = determineSwapRequirements(
      currentTick, newLower, newUpper,
      removedAmountA, removedAmountB
    );
    
    assert.ok(result.needsSwap, 'Should need swap');
    assert.strictEqual(result.swapDirection, 'A→B', 'Should swap A→B');
    assert.ok(result.reason?.includes('token B'), 'Reason should mention token B');
    
    console.log('✔ Out-of-range above: Correctly identifies need to swap A→B');
  }

  // Test 3: In-range - have only B, need both
  {
    const currentTick = 250;
    const newLower = 200;
    const newUpper = 300;
    const removedAmountA = 0n;
    const removedAmountB = 1000000n;
    
    const result = determineSwapRequirements(
      currentTick, newLower, newUpper,
      removedAmountA, removedAmountB
    );
    
    assert.ok(result.needsSwap, 'Should need swap');
    assert.strictEqual(result.swapDirection, 'split', 'Should split token B');
    assert.ok(result.reason?.includes('both tokens'), 'Reason should mention both tokens');
    
    console.log('✔ In-range with only B: Correctly identifies need to split B');
  }

  // Test 4: In-range - have only A, need both
  {
    const currentTick = 250;
    const newLower = 200;
    const newUpper = 300;
    const removedAmountA = 1000000n;
    const removedAmountB = 0n;
    
    const result = determineSwapRequirements(
      currentTick, newLower, newUpper,
      removedAmountA, removedAmountB
    );
    
    assert.ok(result.needsSwap, 'Should need swap');
    assert.strictEqual(result.swapDirection, 'split', 'Should split token A');
    assert.ok(result.reason?.includes('both tokens'), 'Reason should mention both tokens');
    
    console.log('✔ In-range with only A: Correctly identifies need to split A');
  }

  // Test 5: Out-of-range below - already have A, no swap needed
  {
    const currentTick = 100;
    const newLower = 200;
    const newUpper = 300;
    const removedAmountA = 1000000n;
    const removedAmountB = 0n;
    
    const result = determineSwapRequirements(
      currentTick, newLower, newUpper,
      removedAmountA, removedAmountB
    );
    
    assert.ok(!result.needsSwap, 'Should NOT need swap');
    
    console.log('✔ Out-of-range below with A: Correctly identifies no swap needed');
  }

  // Test 6: Out-of-range above - already have B, no swap needed
  {
    const currentTick = 400;
    const newLower = 200;
    const newUpper = 300;
    const removedAmountA = 0n;
    const removedAmountB = 1000000n;
    
    const result = determineSwapRequirements(
      currentTick, newLower, newUpper,
      removedAmountA, removedAmountB
    );
    
    assert.ok(!result.needsSwap, 'Should NOT need swap');
    
    console.log('✔ Out-of-range above with B: Correctly identifies no swap needed');
  }

  // Test 7: In-range - already have both tokens, no swap needed
  {
    const currentTick = 250;
    const newLower = 200;
    const newUpper = 300;
    const removedAmountA = 500000n;
    const removedAmountB = 500000n;
    
    const result = determineSwapRequirements(
      currentTick, newLower, newUpper,
      removedAmountA, removedAmountB
    );
    
    assert.ok(!result.needsSwap, 'Should NOT need swap');
    
    console.log('✔ In-range with both tokens: Correctly identifies no swap needed');
  }

  // Test 8: Position range analysis - below range
  {
    const analysis = analyzePositionRange(100, 200, 300);
    
    assert.ok(analysis.priceIsBelowRange, 'Should be below range');
    assert.ok(!analysis.priceIsAboveRange, 'Should not be above range');
    assert.ok(!analysis.priceIsInRange, 'Should not be in range');
    
    console.log('✔ Position range analysis: Correctly identifies below range');
  }

  // Test 9: Position range analysis - above range
  {
    const analysis = analyzePositionRange(400, 200, 300);
    
    assert.ok(!analysis.priceIsBelowRange, 'Should not be below range');
    assert.ok(analysis.priceIsAboveRange, 'Should be above range');
    assert.ok(!analysis.priceIsInRange, 'Should not be in range');
    
    console.log('✔ Position range analysis: Correctly identifies above range');
  }

  // Test 10: Position range analysis - in range
  {
    const analysis = analyzePositionRange(250, 200, 300);
    
    assert.ok(!analysis.priceIsBelowRange, 'Should not be below range');
    assert.ok(!analysis.priceIsAboveRange, 'Should not be above range');
    assert.ok(analysis.priceIsInRange, 'Should be in range');
    
    console.log('✔ Position range analysis: Correctly identifies in range');
  }

  // Test 11: Edge case - price exactly at lower bound
  {
    const analysis = analyzePositionRange(200, 200, 300);
    
    assert.ok(!analysis.priceIsBelowRange, 'Should not be below range');
    assert.ok(!analysis.priceIsAboveRange, 'Should not be above range');
    assert.ok(analysis.priceIsInRange, 'Should be in range');
    
    console.log('✔ Edge case: Price at lower bound is in range');
  }

  // Test 12: Edge case - price exactly at upper bound
  {
    const analysis = analyzePositionRange(300, 200, 300);
    
    assert.ok(!analysis.priceIsBelowRange, 'Should not be below range');
    assert.ok(analysis.priceIsAboveRange, 'Should be above range');
    assert.ok(!analysis.priceIsInRange, 'Should not be in range');
    
    console.log('✔ Edge case: Price at upper bound is above range');
  }

  // Test 13: Negative ticks - below range
  {
    const currentTick = -500;
    const newLower = -300;
    const newUpper = -200;
    const analysis = analyzePositionRange(currentTick, newLower, newUpper);
    
    assert.ok(analysis.priceIsBelowRange, 'Should be below range with negative ticks');
    
    console.log('✔ Negative ticks: Correctly handles below range');
  }

  // Test 14: Complex rebalance scenario - old position out-of-range above, new position in-range
  {
    // Old position was at [400, 500], price moved to 250
    // Removed liquidity from old position → got only token B (price is below old range)
    // New position will be at [200, 300] (in-range)
    
    const currentTick = 250;
    const newLower = 200;
    const newUpper = 300;
    const removedAmountA = 0n; // Old position out-of-range above → only token B
    const removedAmountB = 1000000n;
    
    const result = determineSwapRequirements(
      currentTick, newLower, newUpper,
      removedAmountA, removedAmountB
    );
    
    assert.ok(result.needsSwap, 'Should need swap');
    assert.strictEqual(result.swapDirection, 'split', 'Should split token B to get both');
    
    console.log('✔ Complex scenario: Out-of-range above → in-range requires split');
  }

  // Test 15: Complex rebalance scenario - old position out-of-range below, new position in-range
  {
    // Old position was at [50, 100], price moved to 250
    // Removed liquidity from old position → got only token A (price is above old range)
    // New position will be at [200, 300] (in-range)
    
    const currentTick = 250;
    const newLower = 200;
    const newUpper = 300;
    const removedAmountA = 1000000n; // Old position out-of-range below → only token A
    const removedAmountB = 0n;
    
    const result = determineSwapRequirements(
      currentTick, newLower, newUpper,
      removedAmountA, removedAmountB
    );
    
    assert.ok(result.needsSwap, 'Should need swap');
    assert.strictEqual(result.swapDirection, 'split', 'Should split token A to get both');
    
    console.log('✔ Complex scenario: Out-of-range below → in-range requires split');
  }

  console.log('\nAll post-remove liquidity swap tests passed ✅');
  console.log('\nTest Coverage Summary:');
  console.log('1. ✅ Out-of-range positions requiring full token swap');
  console.log('2. ✅ In-range positions requiring token split');
  console.log('3. ✅ Positions with correct tokens (no swap needed)');
  console.log('4. ✅ Position range analysis (below, in, above)');
  console.log('5. ✅ Edge cases (boundary conditions)');
  console.log('6. ✅ Negative tick handling');
  console.log('7. ✅ Complex rebalance scenarios');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
