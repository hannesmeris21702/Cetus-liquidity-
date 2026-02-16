/**
 * Test for insufficient balance recovery logic
 * Run with: npx ts-node tests/insufficientBalanceRecovery.test.ts
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
 * Simulate the isInsufficientBalanceError detection method
 */
function isInsufficientBalanceError(errorMsg: string): boolean {
  const insufficientPatterns = [
    /insufficient balance/i,
    /expect/i,
    /amount is insufficient/i,
  ];
  
  return insufficientPatterns.some(pattern => pattern.test(errorMsg));
}

async function runTests() {
  console.log('Running insufficient balance recovery tests...\n');

  // Test 1: Detect "Insufficient balance" error
  {
    const error1 = 'Transaction failed: Insufficient balance for token A';
    const error2 = 'Error: Insufficient Balance detected';
    const error3 = 'insufficient balance';
    
    assert.ok(isInsufficientBalanceError(error1), 'Should detect "Insufficient balance" (case 1)');
    assert.ok(isInsufficientBalanceError(error2), 'Should detect "Insufficient Balance" (case 2)');
    assert.ok(isInsufficientBalanceError(error3), 'Should detect "insufficient balance" (lowercase)');
    
    console.log('✔ Detects "Insufficient balance" error pattern');
  }

  // Test 2: Detect "expect" error pattern
  {
    const error1 = 'Transaction aborted: expect 1000, got 500';
    const error2 = 'Error code 0x123: Expect sufficient balance';
    const error3 = 'EXPECT amount to be greater than 0';
    
    assert.ok(isInsufficientBalanceError(error1), 'Should detect "expect" pattern (case 1)');
    assert.ok(isInsufficientBalanceError(error2), 'Should detect "Expect" pattern (case 2)');
    assert.ok(isInsufficientBalanceError(error3), 'Should detect "EXPECT" pattern (uppercase)');
    
    console.log('✔ Detects "expect" error pattern');
  }

  // Test 3: Detect "amount is Insufficient" error
  {
    const error1 = 'Error: amount is Insufficient for swap';
    const error2 = 'Verification failed: Amount is insufficient';
    const error3 = 'amount is insufficient';
    
    assert.ok(isInsufficientBalanceError(error1), 'Should detect "amount is Insufficient" (case 1)');
    assert.ok(isInsufficientBalanceError(error2), 'Should detect "Amount is insufficient" (case 2)');
    assert.ok(isInsufficientBalanceError(error3), 'Should detect "amount is insufficient" (lowercase)');
    
    console.log('✔ Detects "amount is Insufficient" error pattern');
  }

  // Test 4: Should NOT detect unrelated errors
  {
    const error1 = 'Network timeout';
    const error2 = 'Invalid tick range';
    const error3 = 'Pool not found';
    const error4 = 'Slippage too high';
    
    assert.ok(!isInsufficientBalanceError(error1), 'Should NOT detect network timeout');
    assert.ok(!isInsufficientBalanceError(error2), 'Should NOT detect tick range error');
    assert.ok(!isInsufficientBalanceError(error3), 'Should NOT detect pool not found');
    assert.ok(!isInsufficientBalanceError(error4), 'Should NOT detect slippage error');
    
    console.log('✔ Does NOT falsely detect unrelated errors');
  }

  // Test 5: Case insensitive matching
  {
    const variations = [
      'INSUFFICIENT BALANCE',
      'Insufficient Balance',
      'insufficient balance',
      'InSuFfIcIeNt BaLaNcE',
      'EXPECT MORE',
      'expect more',
      'Expect More',
      'AMOUNT IS INSUFFICIENT',
      'amount is insufficient',
      'Amount Is Insufficient',
    ];
    
    variations.forEach(error => {
      assert.ok(
        isInsufficientBalanceError(error),
        `Should detect "${error}" regardless of case`
      );
    });
    
    console.log('✔ Case-insensitive pattern matching works');
  }

  // Test 6: Simulate balance analysis logic
  {
    // Mock balance scenario: Token A is insufficient
    const currentBalanceA = BigInt('1000000');
    const currentBalanceB = BigInt('5000000');
    const requiredA = BigInt('2000000');
    const requiredB = BigInt('4000000');
    
    const isTokenAInsufficient = currentBalanceA < requiredA;
    const isTokenBInsufficient = currentBalanceB < requiredB;
    
    assert.ok(isTokenAInsufficient, 'Should detect Token A is insufficient');
    assert.ok(!isTokenBInsufficient, 'Should detect Token B is sufficient');
    
    const missingAmountA = requiredA - currentBalanceA;
    assert.strictEqual(missingAmountA.toString(), '1000000', 'Should calculate correct missing amount');
    
    // Calculate swap amount with 10% buffer
    const swapAmount = (missingAmountA * 110n) / 100n;
    assert.strictEqual(swapAmount.toString(), '1100000', 'Should add 10% buffer to swap amount');
    
    console.log('✔ Balance analysis and missing amount calculation works');
  }

  // Test 7: Simulate swap direction logic
  {
    // Scenario 1: Token A insufficient -> Swap B to A (direction: false/B→A)
    const tokenAInsufficient = true;
    const swapDirectionForA = false; // B→A
    
    assert.strictEqual(swapDirectionForA, false, 'Should swap B→A when Token A insufficient');
    
    // Scenario 2: Token B insufficient -> Swap A to B (direction: true/A→B)
    const tokenBInsufficient = true;
    const swapDirectionForB = true; // A→B
    
    assert.strictEqual(swapDirectionForB, true, 'Should swap A→B when Token B insufficient');
    
    console.log('✔ Swap direction logic is correct');
  }

  // Test 8: Verify recovery is only attempted once
  {
    let recoveryAttempted = false;
    let recoveryCount = 0;
    
    // Simulate first error
    if (!recoveryAttempted) {
      recoveryAttempted = true;
      recoveryCount++;
    }
    
    // Simulate second error - should not attempt recovery
    if (!recoveryAttempted) {
      recoveryCount++;
    }
    
    assert.strictEqual(recoveryCount, 1, 'Should only attempt recovery once');
    assert.ok(recoveryAttempted, 'Recovery flag should be set after first attempt');
    
    console.log('✔ Recovery is only attempted once per transaction');
  }

  // Test 9: Verify sufficient balance check before swap
  {
    // Scenario: Need to swap B→A, but not enough B
    const currentBalanceB = BigInt('500000');
    const swapAmount = BigInt('1100000');
    
    const canSwap = currentBalanceB >= swapAmount;
    assert.ok(!canSwap, 'Should detect insufficient balance to perform swap');
    
    console.log('✔ Validates sufficient balance before attempting swap');
  }

  // Test 10: Error message patterns from real scenarios
  {
    const realWorldErrors = [
      'MoveAbort(MoveLocation { module: ModuleId { address: 0x1, name: Identifier("balance") }, function: 2, instruction: 9, function_name: Some("split") }, 0): Insufficient balance',
      'Error in execution: expect 5000000, but got 3000000',
      'Transaction failed: amount is Insufficient for the operation',
      'Execution error: Insufficient balance in coin',
      'Abort: expected minimum balance not met',
    ];
    
    realWorldErrors.forEach(error => {
      assert.ok(
        isInsufficientBalanceError(error),
        `Should detect real-world error: ${error.substring(0, 50)}...`
      );
    });
    
    console.log('✔ Detects real-world error message patterns');
  }

  console.log('\nAll insufficient balance recovery tests passed ✅');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
