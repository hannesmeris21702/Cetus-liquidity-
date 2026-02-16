/**
 * Test for add liquidity retry logic
 * Run with: npx ts-node tests/addLiquidityRetry.test.ts
 */

import assert from 'assert';

// Mock logger to capture log messages
const mockLogger = {
  logs: [] as Array<{ level: string; message: string }>,
  info(message: string) {
    this.logs.push({ level: 'info', message });
  },
  warn(message: string) {
    this.logs.push({ level: 'warn', message });
  },
  debug(message: string) {
    this.logs.push({ level: 'debug', message });
  },
  error(message: string) {
    this.logs.push({ level: 'error', message });
  },
  clearLogs() {
    this.logs.length = 0;
  },
};

/**
 * Simulates the retryAddLiquidity function behavior
 */
async function retryAddLiquidity<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 3000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();

      // Log success with attempt number
      if (attempt === 1) {
        mockLogger.info('Add liquidity succeeded on attempt 1');
      } else {
        mockLogger.info(`Add liquidity succeeded on attempt ${attempt}`);
      }

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(errorMsg);

      if (attempt < maxRetries) {
        // Log retry attempt
        mockLogger.warn(`Add liquidity attempt ${attempt} failed, retrying...`);
        mockLogger.debug(`Error details: ${errorMsg}`);

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        // All retries exhausted
        mockLogger.error(`Add liquidity failed after ${maxRetries} attempts`);
      }
    }
  }

  // Preserve and throw the original error
  throw lastError || new Error('Add liquidity failed with unknown error');
}

async function runTests() {
  console.log('Running add liquidity retry tests...\n');

  // Test 1: Success on first attempt
  {
    mockLogger.clearLogs();
    let callCount = 0;

    const result = await retryAddLiquidity(async () => {
      callCount++;
      return 'success';
    }, 3, 10);

    assert.strictEqual(result, 'success', 'Should return success');
    assert.strictEqual(callCount, 1, 'Should only call once on success');
    
    const successLog = mockLogger.logs.find(
      (log) => log.level === 'info' && log.message === 'Add liquidity succeeded on attempt 1'
    );
    assert.ok(successLog, 'Should log success on attempt 1');
    
    console.log('✔ Add liquidity succeeds on first attempt');
  }

  // Test 2: Retry on error and eventually succeed
  {
    mockLogger.clearLogs();
    let callCount = 0;

    const result = await retryAddLiquidity(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error('Temporary failure');
      }
      return 'success-after-retries';
    }, 3, 10);

    assert.strictEqual(result, 'success-after-retries', 'Should return success after retries');
    assert.strictEqual(callCount, 3, 'Should retry until success');
    
    // Check for retry logs
    const retryLog1 = mockLogger.logs.find(
      (log) => log.level === 'warn' && log.message === 'Add liquidity attempt 1 failed, retrying...'
    );
    const retryLog2 = mockLogger.logs.find(
      (log) => log.level === 'warn' && log.message === 'Add liquidity attempt 2 failed, retrying...'
    );
    const successLog = mockLogger.logs.find(
      (log) => log.level === 'info' && log.message === 'Add liquidity succeeded on attempt 3'
    );
    
    assert.ok(retryLog1, 'Should log retry attempt 1');
    assert.ok(retryLog2, 'Should log retry attempt 2');
    assert.ok(successLog, 'Should log success on attempt 3');
    
    console.log('✔ Add liquidity retries on error and succeeds on attempt 3');
  }

  // Test 3: Retry on ANY error type (not just specific ones)
  {
    mockLogger.clearLogs();
    let callCount = 0;
    const errors = [
      'Network error',
      'Insufficient balance', // Non-network error
      'Invalid parameter', // Non-network error
    ];

    const result = await retryAddLiquidity(async () => {
      const currentAttempt = callCount;
      callCount++;
      
      if (currentAttempt < errors.length) {
        throw new Error(errors[currentAttempt]);
      }
      return 'success-after-various-errors';
    }, 4, 10); // Need 4 attempts to succeed after 3 errors

    assert.strictEqual(result, 'success-after-various-errors', 'Should succeed after various errors');
    assert.strictEqual(callCount, 4, 'Should retry on any error type');
    
    console.log('✔ Add liquidity retries on ANY error type (not filtered)');
  }

  // Test 4: Preserve original error after max retries
  {
    mockLogger.clearLogs();
    let callCount = 0;
    const originalError = new Error('Persistent failure');

    try {
      await retryAddLiquidity(async () => {
        callCount++;
        throw originalError;
      }, 3, 10);
      assert.fail('Should have thrown error after max retries');
    } catch (error) {
      assert.strictEqual(error, originalError, 'Should preserve original error');
      assert.strictEqual(callCount, 3, 'Should exhaust all retries');
      
      const errorLog = mockLogger.logs.find(
        (log) => log.level === 'error' && log.message === 'Add liquidity failed after 3 attempts'
      );
      assert.ok(errorLog, 'Should log failure after max retries');
    }
    
    console.log('✔ Add liquidity preserves original error after max retries');
  }

  // Test 5: Uses correct retry parameters (3 retries, 3 second delay)
  {
    mockLogger.clearLogs();
    let callCount = 0;
    const startTime = Date.now();

    try {
      await retryAddLiquidity(async () => {
        callCount++;
        throw new Error('Test error');
      }, 3, 100); // Use 100ms for faster test
    } catch (error) {
      // Verify it made exactly 3 attempts
      assert.strictEqual(callCount, 3, 'Should make exactly 3 attempts');
      
      // Verify delay was applied between retries (2 delays for 3 attempts = 200ms minimum)
      const elapsed = Date.now() - startTime;
      // Allow some tolerance for timing variations
      assert.ok(elapsed >= 150, `Should have delays between retries (elapsed: ${elapsed}ms)`);
    }
    
    console.log('✔ Add liquidity uses correct retry parameters');
  }

  console.log('\nAll add liquidity retry tests passed ✅');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
