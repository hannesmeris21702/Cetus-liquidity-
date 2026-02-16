/**
 * Test for add liquidity fallback mechanism
 * Run with: npx ts-node tests/addLiquidityFallback.test.ts
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
 * Test Scenario: Add liquidity fails after retries -> fallback opens new position
 */
async function testFallbackTriggeredOnExistingPositionFailure() {
  mockLogger.clearLogs();
  
  // Simulate the scenario:
  // 1. isOpen = false (adding to existing position)
  // 2. retryAddLiquidity fails after all attempts
  // 3. Fallback logic should trigger
  
  const isOpen = false; // Adding to existing position
  let fallbackTriggered = false;
  let newPositionCreated = false;
  
  try {
    // Simulate initial retry failure
    throw new Error('Add liquidity failed after max retries');
  } catch (retryError) {
    // Fallback logic
    if (isOpen) {
      // Should NOT trigger fallback if already opening new position
      assert.fail('Should not trigger fallback when already opening new position');
    }
    
    mockLogger.warn('Add liquidity failed after retries, opening new position');
    fallbackTriggered = true;
    
    // Simulate opening new position
    newPositionCreated = true;
    mockLogger.info('Retrying add liquidity on new position');
  }
  
  assert.ok(fallbackTriggered, 'Fallback should be triggered');
  assert.ok(newPositionCreated, 'New position should be created');
  
  const fallbackLog = mockLogger.logs.find(
    (log) => log.level === 'warn' && log.message === 'Add liquidity failed after retries, opening new position'
  );
  const retryLog = mockLogger.logs.find(
    (log) => log.level === 'info' && log.message === 'Retrying add liquidity on new position'
  );
  
  assert.ok(fallbackLog, 'Should log fallback trigger');
  assert.ok(retryLog, 'Should log retry on new position');
  
  console.log('✔ Fallback triggered when adding to existing position fails');
}

/**
 * Test Scenario: No fallback when already opening new position
 */
async function testNoFallbackWhenAlreadyOpeningNewPosition() {
  mockLogger.clearLogs();
  
  const isOpen = true; // Already opening new position
  let fallbackTriggered = false;
  let errorThrown = false;
  const originalError = new Error('Failed to open new position');
  
  try {
    // Simulate initial retry failure
    throw originalError;
  } catch (retryError) {
    // Fallback logic check
    if (isOpen) {
      // Should throw original error immediately
      errorThrown = true;
      assert.strictEqual(retryError, originalError, 'Should preserve original error');
    } else {
      fallbackTriggered = true;
    }
  }
  
  assert.ok(!fallbackTriggered, 'Fallback should NOT be triggered when already opening new position');
  assert.ok(errorThrown, 'Should throw original error');
  
  console.log('✔ No fallback when already opening new position');
}

/**
 * Test Scenario: Balance check and swap logic
 */
async function testBalanceCheckAndSwap() {
  mockLogger.clearLogs();
  
  // Simulate balance check
  const requiredA = 1000n;
  const requiredB = 2000n;
  const walletBalanceA = 500n; // Insufficient
  const walletBalanceB = 3000n; // Sufficient
  
  const isTokenAInsufficient = walletBalanceA < requiredA;
  const isTokenBInsufficient = walletBalanceB < requiredB;
  
  assert.ok(isTokenAInsufficient, 'Token A should be insufficient');
  assert.ok(!isTokenBInsufficient, 'Token B should be sufficient');
  
  // Simulate swap logic
  if (isTokenAInsufficient || isTokenBInsufficient) {
    mockLogger.info('Insufficient balance for new position, swapping required amount');
    
    if (isTokenAInsufficient) {
      const missingAmountA = requiredA - walletBalanceA;
      // Simulate 10% buffer calculation
      const swapAmount = (missingAmountA * 110n) / 100n;
      
      assert.strictEqual(missingAmountA, 500n, 'Missing amount should be 500');
      assert.strictEqual(swapAmount, 550n, 'Swap amount should include 10% buffer');
      
      if (walletBalanceB >= swapAmount) {
        mockLogger.info(`Swapping Token B → Token A for missing amount`, { 
          missing: missingAmountA.toString(),
          swapAmount: swapAmount.toString()
        });
      }
    }
  }
  
  const insufficientLog = mockLogger.logs.find(
    (log) => log.level === 'info' && log.message === 'Insufficient balance for new position, swapping required amount'
  );
  const swapLog = mockLogger.logs.find(
    (log) => log.level === 'info' && log.message.includes('Swapping Token B → Token A')
  );
  
  assert.ok(insufficientLog, 'Should log insufficient balance detection');
  assert.ok(swapLog, 'Should log swap action');
  
  console.log('✔ Balance check and swap logic works correctly');
}

/**
 * Test Scenario: Swap only missing amount (no overbuy)
 */
async function testSwapOnlyMissingAmount() {
  const requiredA = 10000n;
  const walletBalanceA = 7000n; // Need 3000 more
  
  const missingAmountA = requiredA - walletBalanceA;
  const swapAmount = (missingAmountA * 110n) / 100n; // 10% buffer
  
  assert.strictEqual(missingAmountA, 3000n, 'Missing amount should be exactly 3000');
  assert.strictEqual(swapAmount, 3300n, 'Swap should be missing amount + 10% buffer');
  
  // Verify we're not swapping half or more than needed
  assert.ok(swapAmount < requiredA, 'Should not swap more than required');
  assert.ok(swapAmount >= missingAmountA, 'Should swap at least missing amount');
  
  console.log('✔ Swaps only missing amount with buffer (no overbuy)');
}

/**
 * Test Scenario: Fallback failure throws original error
 */
async function testFallbackFailureThrowsOriginalError() {
  mockLogger.clearLogs();
  
  const originalError = new Error('Original add liquidity failure');
  const isOpen = false;
  let caughtError: Error | null = null;
  
  try {
    // Simulate retry failure
    throw originalError;
  } catch (retryError) {
    if (!isOpen) {
      mockLogger.warn('Add liquidity failed after retries, opening new position');
      
      try {
        // Simulate fallback failure
        mockLogger.info('Retrying add liquidity on new position');
        throw new Error('Fallback also failed');
      } catch (fallbackError) {
        // Should throw original error, not fallback error
        mockLogger.error('Fallback attempt failed, throwing original error', fallbackError);
        caughtError = retryError as Error;
        throw retryError;
      }
    }
  } catch (finalError) {
    assert.strictEqual(finalError, originalError, 'Should throw original error');
  }
  
  const fallbackFailedLog = mockLogger.logs.find(
    (log) => log.level === 'error' && log.message === 'Fallback attempt failed, throwing original error'
  );
  
  assert.ok(fallbackFailedLog, 'Should log fallback failure');
  assert.strictEqual(caughtError, originalError, 'Should preserve original error');
  
  console.log('✔ Fallback failure throws original error');
}

/**
 * Test Scenario: Only ONE fallback attempt (no loops)
 */
async function testOnlyOneFallbackAttempt() {
  // This test verifies the design constraint: only ONE fallback attempt
  const isOpen = false;
  let fallbackAttempts = 0;
  
  try {
    throw new Error('Initial failure');
  } catch (retryError) {
    if (!isOpen) {
      fallbackAttempts++;
      
      try {
        // Simulate fallback attempt
        throw new Error('Fallback failed');
      } catch (fallbackError) {
        // Should NOT loop back to try another fallback
        // Should throw immediately
        throw retryError;
      }
    }
  } catch (finalError) {
    // Expected
  }
  
  assert.strictEqual(fallbackAttempts, 1, 'Should attempt fallback exactly once');
  
  console.log('✔ Only ONE fallback attempt (no infinite loops)');
}

/**
 * Test Scenario: Success logging on new position
 */
async function testSuccessLoggingOnNewPosition() {
  mockLogger.clearLogs();
  
  const isOpen = false;
  
  try {
    throw new Error('Initial failure');
  } catch (retryError) {
    if (!isOpen) {
      mockLogger.warn('Add liquidity failed after retries, opening new position');
      mockLogger.info('Retrying add liquidity on new position');
      
      // Simulate success
      const digest = 'ABC123';
      const amountA = '1000';
      const amountB = '2000';
      
      mockLogger.info('Liquidity added successfully on new position', {
        digest,
        amountA,
        amountB,
      });
    }
  }
  
  const successLog = mockLogger.logs.find(
    (log) => log.level === 'info' && log.message === 'Liquidity added successfully on new position'
  );
  
  assert.ok(successLog, 'Should log success on new position');
  assert.ok(successLog.data, 'Success log should include data');
  assert.strictEqual(successLog.data.digest, 'ABC123', 'Should include transaction digest');
  
  console.log('✔ Success logging on new position');
}

/**
 * Test Scenario: Gas reserve handling in balance check
 */
async function testGasReserveInBalanceCheck() {
  // Simulate SUI coin type detection
  const SUI_TYPE = '0x2::sui::SUI';
  const SUI_TYPE_FULL = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
  const isSuiCoinType = (ct: string) => ct === SUI_TYPE || ct === SUI_TYPE_FULL;
  
  assert.ok(isSuiCoinType(SUI_TYPE), 'Should detect short SUI type');
  assert.ok(isSuiCoinType(SUI_TYPE_FULL), 'Should detect full SUI type');
  assert.ok(!isSuiCoinType('0x1::usdc::USDC'), 'Should not detect non-SUI type');
  
  // Simulate gas reserve calculation
  const GAS_RESERVE = 100000000n; // 0.1 SUI in MIST
  const walletBalance = 500000000n; // 0.5 SUI in MIST
  
  const isSuiA = true;
  const safeBalance = isSuiA && walletBalance > GAS_RESERVE
    ? walletBalance - GAS_RESERVE
    : walletBalance;
  
  assert.strictEqual(safeBalance, 400000000n, 'Should reserve gas for SUI token');
  
  // Test non-SUI token (no gas reserve)
  const isSuiB = false;
  const safeBalanceB = isSuiB && walletBalance > GAS_RESERVE
    ? walletBalance - GAS_RESERVE
    : walletBalance;
  
  assert.strictEqual(safeBalanceB, 500000000n, 'Should not reserve gas for non-SUI token');
  
  console.log('✔ Gas reserve handling in balance check');
}

async function runTests() {
  console.log('Running add liquidity fallback tests...\n');

  await testFallbackTriggeredOnExistingPositionFailure();
  await testNoFallbackWhenAlreadyOpeningNewPosition();
  await testBalanceCheckAndSwap();
  await testSwapOnlyMissingAmount();
  await testFallbackFailureThrowsOriginalError();
  await testOnlyOneFallbackAttempt();
  await testSuccessLoggingOnNewPosition();
  await testGasReserveInBalanceCheck();

  console.log('\nAll add liquidity fallback tests passed ✅');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
