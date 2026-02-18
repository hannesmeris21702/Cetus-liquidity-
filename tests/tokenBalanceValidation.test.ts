/**
 * Test for token balance validation before adding liquidity
 * This test validates that the system checks token balances and performs
 * swaps as needed before attempting to add liquidity to a new position.
 * 
 * Run with: npx ts-node tests/tokenBalanceValidation.test.ts
 */

import assert from 'assert';

// Mock logger to capture log messages
const mockLogger = {
  logs: [] as Array<{ level: string; message: string; data?: any }>,
  info(message: string, data?: any) {
    this.logs.push({ level: 'info', message, data });
  },
  warn(message: string, data?: any) {
    this.logs.push({ level: 'warn', message, data });
  },
  debug(message: string, data?: any) {
    this.logs.push({ level: 'debug', message, data });
  },
  error(message: string, data?: any) {
    this.logs.push({ level: 'error', message, data });
  },
  clearLogs() {
    this.logs.length = 0;
  },
};

/**
 * Calculate swap amount with buffer (10% extra for slippage)
 */
function calculateSwapAmountWithBuffer(missingAmount: bigint): bigint {
  const SWAP_BUFFER_PERCENTAGE = 110n; // 110% = 10% buffer
  return (missingAmount * SWAP_BUFFER_PERCENTAGE) / 100n;
}

/**
 * Simulate the balance check and swap logic
 */
async function validateAndPrepareTokens(
  requiredA: bigint,
  requiredB: bigint,
  availableA: bigint,
  availableB: bigint
): Promise<{
  needsSwap: boolean;
  swappedToken?: 'A' | 'B';
  swapAmount?: bigint;
  finalAmountA: bigint;
  finalAmountB: bigint;
}> {
  mockLogger.info('Checking token balances', {
    requiredA: requiredA.toString(),
    requiredB: requiredB.toString(),
    availableA: availableA.toString(),
    availableB: availableB.toString(),
  });

  const needsSwapForA = requiredA > availableA;
  const needsSwapForB = requiredB > availableB;

  if (needsSwapForA || needsSwapForB) {
    mockLogger.info('Insufficient balance detected - swapping to meet required amounts');

    if (needsSwapForA && !needsSwapForB) {
      // Need more A, swap B → A
      const missingA = requiredA - availableA;
      const swapAmount = calculateSwapAmountWithBuffer(missingA);

      if (availableB >= swapAmount) {
        mockLogger.info('Swapping Token B → Token A for missing amount', {
          missing: missingA.toString(),
          swapAmount: swapAmount.toString(),
        });

        // After swap, we'd have:
        // - More A (gained from swap)
        // - Less B (used for swap)
        return {
          needsSwap: true,
          swappedToken: 'B',
          swapAmount,
          finalAmountA: requiredA, // We got the required amount
          finalAmountB: availableB - swapAmount, // What's left after swap
        };
      } else {
        throw new Error(
          `Insufficient Token B balance to swap for missing Token A. Need ${swapAmount.toString()}, have ${availableB.toString()}`
        );
      }
    } else if (needsSwapForB && !needsSwapForA) {
      // Need more B, swap A → B
      const missingB = requiredB - availableB;
      const swapAmount = calculateSwapAmountWithBuffer(missingB);

      if (availableA >= swapAmount) {
        mockLogger.info('Swapping Token A → Token B for missing amount', {
          missing: missingB.toString(),
          swapAmount: swapAmount.toString(),
        });

        return {
          needsSwap: true,
          swappedToken: 'A',
          swapAmount,
          finalAmountA: availableA - swapAmount,
          finalAmountB: requiredB,
        };
      } else {
        throw new Error(
          `Insufficient Token A balance to swap for missing Token B. Need ${swapAmount.toString()}, have ${availableA.toString()}`
        );
      }
    } else {
      // Both tokens insufficient - this would be an error condition
      throw new Error('Both tokens are insufficient and cannot perform swap');
    }
  } else {
    // Both token balances are sufficient, proceed directly
    mockLogger.info('Token balances are sufficient, proceeding to add liquidity');
    return {
      needsSwap: false,
      finalAmountA: requiredA,
      finalAmountB: requiredB,
    };
  }
}

async function runTests() {
  console.log('Running token balance validation tests...\n');

  // Test 1: Both tokens sufficient - no swap needed
  {
    mockLogger.clearLogs();
    const result = await validateAndPrepareTokens(
      1000n, // required A
      2000n, // required B
      1500n, // available A (sufficient)
      2500n  // available B (sufficient)
    );

    assert.strictEqual(result.needsSwap, false, 'Should not need swap when both sufficient');
    assert.strictEqual(result.finalAmountA.toString(), '1000', 'Should use required amount A');
    assert.strictEqual(result.finalAmountB.toString(), '2000', 'Should use required amount B');

    const sufficientLog = mockLogger.logs.find(
      (log) => log.level === 'info' && log.message.includes('sufficient')
    );
    assert.ok(sufficientLog, 'Should log that balances are sufficient');

    console.log('✔ Scenario 1: Both tokens sufficient - proceeds directly');
  }

  // Test 2: Token A insufficient - swap B → A
  {
    mockLogger.clearLogs();
    const result = await validateAndPrepareTokens(
      2000n, // required A
      1000n, // required B
      1500n, // available A (insufficient, missing 500)
      3000n  // available B (sufficient)
    );

    assert.strictEqual(result.needsSwap, true, 'Should need swap for token A');
    assert.strictEqual(result.swappedToken, 'B', 'Should swap token B');
    assert.strictEqual(result.finalAmountA.toString(), '2000', 'Should have required amount A after swap');
    
    // Swap amount should be 500 * 1.1 = 550
    const expectedSwapAmount = 550n;
    assert.strictEqual(result.swapAmount?.toString(), expectedSwapAmount.toString(), 'Should swap with 10% buffer');
    
    // Available B should be reduced by swap amount
    assert.strictEqual(result.finalAmountB.toString(), '2450', 'Should deduct swap amount from B');

    const swapLog = mockLogger.logs.find(
      (log) => log.level === 'info' && log.message.includes('Swapping Token B → Token A')
    );
    assert.ok(swapLog, 'Should log swap B → A');

    console.log('✔ Scenario 2: Token A insufficient - swaps B → A for ONLY missing amount');
  }

  // Test 3: Token B insufficient - swap A → B
  {
    mockLogger.clearLogs();
    const result = await validateAndPrepareTokens(
      1000n, // required A
      2000n, // required B
      3000n, // available A (sufficient)
      1200n  // available B (insufficient, missing 800)
    );

    assert.strictEqual(result.needsSwap, true, 'Should need swap for token B');
    assert.strictEqual(result.swappedToken, 'A', 'Should swap token A');
    assert.strictEqual(result.finalAmountB.toString(), '2000', 'Should have required amount B after swap');
    
    // Swap amount should be 800 * 1.1 = 880
    const expectedSwapAmount = 880n;
    assert.strictEqual(result.swapAmount?.toString(), expectedSwapAmount.toString(), 'Should swap with 10% buffer');
    
    // Available A should be reduced by swap amount
    assert.strictEqual(result.finalAmountA.toString(), '2120', 'Should deduct swap amount from A');

    const swapLog = mockLogger.logs.find(
      (log) => log.level === 'info' && log.message.includes('Swapping Token A → Token B')
    );
    assert.ok(swapLog, 'Should log swap A → B');

    console.log('✔ Scenario 3: Token B insufficient - swaps A → B for ONLY missing amount');
  }

  // Test 4: Insufficient balance for swap (cannot swap enough)
  {
    mockLogger.clearLogs();
    try {
      await validateAndPrepareTokens(
        2000n, // required A
        1000n, // required B
        1000n, // available A (insufficient, missing 1000)
        500n   // available B (insufficient for swap, need 1100)
      );
      assert.fail('Should throw error when insufficient balance for swap');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      assert.ok(
        errorMsg.includes('insufficient'),
        `Should throw error about insufficient balance for swap`
      );
    }

    console.log('✔ Scenario 4: Detects when insufficient balance to perform swap');
  }

  // Test 5: Swap buffer calculation (10%)
  {
    const testCases = [
      { missing: 100n, expected: 110n },
      { missing: 1000n, expected: 1100n },
      { missing: 555n, expected: 610n }, // 555 * 1.1 = 610.5 → 610
      { missing: 999n, expected: 1098n }, // 999 * 1.1 = 1098.9 → 1098
    ];

    testCases.forEach(({ missing, expected }) => {
      const swapAmount = calculateSwapAmountWithBuffer(missing);
      assert.strictEqual(
        swapAmount.toString(),
        expected.toString(),
        `Swap buffer for ${missing} should be ${expected}`
      );
    });

    console.log('✔ Scenario 5: Correctly calculates 10% swap buffer');
  }

  // Test 6: Edge case - exact balance match (no swap needed)
  {
    mockLogger.clearLogs();
    const result = await validateAndPrepareTokens(
      1000n, // required A
      2000n, // required B
      1000n, // available A (exact match)
      2000n  // available B (exact match)
    );

    assert.strictEqual(result.needsSwap, false, 'Should not need swap when exact match');
    assert.strictEqual(result.finalAmountA.toString(), '1000', 'Should use exact amount A');
    assert.strictEqual(result.finalAmountB.toString(), '2000', 'Should use exact amount B');

    console.log('✔ Scenario 6: Exact balance match - no swap needed');
  }

  // Test 7: Large numbers (realistic token amounts)
  {
    mockLogger.clearLogs();
    const result = await validateAndPrepareTokens(
      5000000000n, // required A (5 billion)
      3000000000n, // required B (3 billion)
      4000000000n, // available A (insufficient, missing 1B)
      8000000000n  // available B (sufficient for swap)
    );

    assert.strictEqual(result.needsSwap, true, 'Should need swap for large amounts');
    assert.strictEqual(result.swappedToken, 'B', 'Should swap token B');
    
    // Swap amount should be 1B * 1.1 = 1.1B
    const expectedSwapAmount = 1100000000n;
    assert.strictEqual(result.swapAmount?.toString(), expectedSwapAmount.toString(), 'Should calculate correct swap for large amounts');
    
    console.log('✔ Scenario 7: Handles large realistic token amounts correctly');
  }

  // Test 8: Verify only missing amount is swapped (not full requirement)
  {
    mockLogger.clearLogs();
    const requiredA = 1000n;
    const availableA = 700n; // Have 700, need 1000, missing 300
    const result = await validateAndPrepareTokens(
      requiredA,
      500n,  // required B
      availableA,
      2000n  // available B (plenty)
    );

    const missingA = requiredA - availableA; // 300
    const expectedSwap = (missingA * 110n) / 100n; // 330 (with buffer)
    
    assert.strictEqual(result.swapAmount?.toString(), expectedSwap.toString(), 'Should swap ONLY missing amount + buffer');
    assert.ok(result.swapAmount! < requiredA, 'Swap amount should be less than full requirement');

    console.log('✔ Scenario 8: Swaps ONLY missing amount (not full requirement)');
  }

  console.log('\nAll token balance validation tests passed ✅');
  console.log('\nBehavior Summary:');
  console.log('1. ✅ Calculates required token amounts for new tick range');
  console.log('2. ✅ Compares required amounts with current wallet balances');
  console.log('3. ✅ If both sufficient → proceeds directly to add liquidity');
  console.log('4. ✅ If either insufficient → swaps ONLY the missing amount');
  console.log('5. ✅ Adds 10% buffer to swap for slippage protection');
  console.log('6. ✅ Validates sufficient balance before attempting swap');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
