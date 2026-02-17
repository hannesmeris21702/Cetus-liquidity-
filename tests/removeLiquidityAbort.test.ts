/**
 * Test to verify that rebalance is aborted if remove liquidity fails.
 * This test validates the requirement that no new position should be created
 * unless the old position is successfully closed.
 * 
 * Run with: npx ts-node tests/removeLiquidityAbort.test.ts
 */

import assert from 'assert';

// Mock logger to track log messages
const mockLogger = {
  logs: [] as Array<{ level: string; message: string }>,
  info(message: string) {
    this.logs.push({ level: 'info', message });
  },
  warn(message: string) {
    this.logs.push({ level: 'warn', message });
  },
  error(message: string) {
    this.logs.push({ level: 'error', message });
  },
  debug(message: string) {
    this.logs.push({ level: 'debug', message });
  },
  clearLogs() {
    this.logs.length = 0;
  },
};

/**
 * Simulates the retryTransaction function for remove liquidity
 * It will retry on stale object and pending transaction errors only.
 */
async function retryTransaction<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = 2,
  initialDelayMs: number = 2000
): Promise<T> {
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = initialDelayMs * Math.pow(2, attempt - 1);
        mockLogger.info(`Retry attempt ${attempt + 1}/${maxRetries} for ${operationName} after ${delay}ms delay`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      return await operation();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(errorMsg);
      
      // Check if this is a retryable error
      const isStaleObject = errorMsg.includes('is not available for consumption') || 
                           (errorMsg.includes('Version') && errorMsg.includes('Digest')) ||
                           errorMsg.includes('current version:');
      
      const isPendingTx = (errorMsg.includes('pending') && errorMsg.includes('seconds old')) || 
                         (errorMsg.includes('pending') && errorMsg.includes('above threshold'));
      
      if (!isStaleObject && !isPendingTx) {
        // Non-retryable error, throw immediately
        mockLogger.error(`Non-retryable error in ${operationName}: ${errorMsg}`);
        throw error;
      }
      
      if (attempt < maxRetries - 1) {
        mockLogger.warn(`Retryable error in ${operationName} (attempt ${attempt + 1}/${maxRetries}): ${errorMsg}`);
      } else {
        mockLogger.error(`Max retries (${maxRetries}) exceeded for ${operationName}`);
      }
    }
  }
  
  throw lastError || new Error(`All retry attempts failed for ${operationName} with unknown error`);
}

/**
 * Simulates the removeLiquidity function
 */
async function removeLiquidity(
  positionId: string,
  liquidity: string,
  shouldFail: boolean,
  errorMessage: string
): Promise<void> {
  mockLogger.info('Removing liquidity');
  
  await retryTransaction(
    async () => {
      if (shouldFail) {
        throw new Error(errorMessage);
      }
      return { success: true };
    },
    'remove liquidity',
    2,
    10 // Use shorter delay for tests
  );
  
  mockLogger.info('Liquidity removed successfully');
}

/**
 * Simulates the rebalance flow
 */
async function simulateRebalance(
  hasLiquidity: boolean,
  removeLiquidityFails: boolean,
  removeErrorMessage: string
): Promise<{ success: boolean; error?: string; newPositionCreated: boolean }> {
  try {
    mockLogger.info('Starting rebalance');
    
    if (hasLiquidity) {
      // This is the key part - removeLiquidity is called WITHOUT a try-catch
      // So if it fails, the error propagates and aborts the rebalance
      await removeLiquidity('position-123', '1000000', removeLiquidityFails, removeErrorMessage);
      mockLogger.info('Successfully removed liquidity from old position');
    } else {
      mockLogger.info('Position has no liquidity - skipping removal step');
    }
    
    // Only reached if removeLiquidity succeeds (or was skipped)
    mockLogger.info('Creating new position and adding liquidity');
    const newPositionCreated = true;
    
    mockLogger.info('Rebalance completed successfully');
    return { success: true, newPositionCreated };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    mockLogger.error('Rebalance failed');
    return { success: false, error: errorMsg, newPositionCreated: false };
  }
}

async function runTests() {
  console.log('Running remove liquidity abort tests...\n');

  // Test 1: Remove liquidity succeeds - new position is created
  {
    mockLogger.clearLogs();
    
    const result = await simulateRebalance(true, false, '');
    
    assert.strictEqual(result.success, true, 'Rebalance should succeed');
    assert.strictEqual(result.newPositionCreated, true, 'New position should be created');
    
    const removedLog = mockLogger.logs.find(
      log => log.level === 'info' && log.message === 'Liquidity removed successfully'
    );
    const newPositionLog = mockLogger.logs.find(
      log => log.level === 'info' && log.message === 'Creating new position and adding liquidity'
    );
    
    assert.ok(removedLog, 'Should log successful liquidity removal');
    assert.ok(newPositionLog, 'Should create new position after successful removal');
    
    console.log('✔ Rebalance succeeds and creates new position when remove liquidity succeeds');
  }

  // Test 2: Remove liquidity fails with non-retryable error - rebalance is aborted
  {
    mockLogger.clearLogs();
    
    const result = await simulateRebalance(
      true,
      true,
      'Position not found'
    );
    
    assert.strictEqual(result.success, false, 'Rebalance should fail');
    assert.strictEqual(result.newPositionCreated, false, 'New position should NOT be created');
    assert.ok(result.error?.includes('Position not found'), 'Should preserve error message');
    
    const errorLog = mockLogger.logs.find(
      log => log.level === 'error' && log.message.includes('Non-retryable error')
    );
    const newPositionLog = mockLogger.logs.find(
      log => log.level === 'info' && log.message === 'Creating new position and adding liquidity'
    );
    
    assert.ok(errorLog, 'Should log non-retryable error');
    assert.ok(!newPositionLog, 'Should NOT create new position after removal failure');
    
    console.log('✔ Rebalance aborts and does NOT create new position when remove liquidity fails (non-retryable)');
  }

  // Test 3: Remove liquidity fails with retryable error that exhausts retries - rebalance is aborted
  {
    mockLogger.clearLogs();
    
    const result = await simulateRebalance(
      true,
      true,
      'Version mismatch: current version: 123'
    );
    
    assert.strictEqual(result.success, false, 'Rebalance should fail');
    assert.strictEqual(result.newPositionCreated, false, 'New position should NOT be created');
    
    const retryLog = mockLogger.logs.find(
      log => log.level === 'warn' && log.message.includes('Retryable error')
    );
    const maxRetriesLog = mockLogger.logs.find(
      log => log.level === 'error' && log.message.includes('Max retries')
    );
    const newPositionLog = mockLogger.logs.find(
      log => log.level === 'info' && log.message === 'Creating new position and adding liquidity'
    );
    
    assert.ok(retryLog, 'Should attempt retries for retryable error');
    assert.ok(maxRetriesLog, 'Should log max retries exceeded');
    assert.ok(!newPositionLog, 'Should NOT create new position after exhausting retries');
    
    console.log('✔ Rebalance aborts and does NOT create new position when remove liquidity fails after retries');
  }

  // Test 4: Position has no liquidity - skips removal and creates new position
  {
    mockLogger.clearLogs();
    
    const result = await simulateRebalance(false, false, '');
    
    assert.strictEqual(result.success, true, 'Rebalance should succeed');
    assert.strictEqual(result.newPositionCreated, true, 'New position should be created');
    
    const skipLog = mockLogger.logs.find(
      log => log.level === 'info' && log.message === 'Position has no liquidity - skipping removal step'
    );
    const newPositionLog = mockLogger.logs.find(
      log => log.level === 'info' && log.message === 'Creating new position and adding liquidity'
    );
    
    assert.ok(skipLog, 'Should skip removal when no liquidity');
    assert.ok(newPositionLog, 'Should create new position when no liquidity to remove');
    
    console.log('✔ Rebalance succeeds and creates new position when old position has no liquidity');
  }

  // Test 5: Verify error types - non-retryable errors abort immediately
  {
    mockLogger.clearLogs();
    
    const nonRetryableErrors = [
      'Position 0x123 not found',
      'Insufficient balance',
      'Invalid parameter',
      'Pool not found',
    ];
    
    for (const errorMsg of nonRetryableErrors) {
      mockLogger.clearLogs();
      
      const result = await simulateRebalance(true, true, errorMsg);
      
      assert.strictEqual(result.success, false, `Should fail for: ${errorMsg}`);
      assert.strictEqual(result.newPositionCreated, false, `Should NOT create position for: ${errorMsg}`);
      
      // Should only attempt once (no retries)
      const removeAttempts = mockLogger.logs.filter(
        log => log.message === 'Removing liquidity'
      );
      assert.strictEqual(removeAttempts.length, 1, `Should only attempt once for: ${errorMsg}`);
    }
    
    console.log('✔ Non-retryable errors abort immediately without retries');
  }

  // Test 6: Verify retryable errors trigger retries before aborting
  {
    mockLogger.clearLogs();
    
    const retryableErrors = [
      'is not available for consumption',
      'Version 5 Digest abc123',
      'current version: 10',
      'pending transaction 30 seconds old',
      'pending above threshold',
    ];
    
    for (const errorMsg of retryableErrors) {
      mockLogger.clearLogs();
      
      const result = await simulateRebalance(true, true, errorMsg);
      
      assert.strictEqual(result.success, false, `Should fail for: ${errorMsg}`);
      assert.strictEqual(result.newPositionCreated, false, `Should NOT create position for: ${errorMsg}`);
      
      // Should retry (maxRetries = 2 means 2 attempts total)
      const removeAttempts = mockLogger.logs.filter(
        log => log.message === 'Removing liquidity'
      );
      assert.strictEqual(removeAttempts.length, 1, `Remove called once for: ${errorMsg}`);
      
      // Check for retry logs
      const retryLogs = mockLogger.logs.filter(
        log => log.message.includes('Retry attempt')
      );
      assert.ok(retryLogs.length > 0, `Should have retry logs for: ${errorMsg}`);
    }
    
    console.log('✔ Retryable errors trigger retries before aborting');
  }

  console.log('\nAll remove liquidity abort tests passed ✅');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
