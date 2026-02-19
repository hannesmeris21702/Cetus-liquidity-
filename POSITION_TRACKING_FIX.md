# Position Tracking and Add Liquidity Fix

## Problem Summary

The bot was experiencing an issue where it would continuously try to rebalance a position that didn't exist, leading to repeated warnings:

```
[WARN] Tracked position 0x429b9cb... not found in pool — skipping
```

This happened when:
1. Bot removed liquidity from an old tracked position (leaving it with 0 liquidity)
2. Bot attempted to add liquidity to create a new position - **THIS FAILED**
3. `trackedPositionId` still pointed to the old position with 0 liquidity
4. Next check cycle filtered out positions with 0 liquidity
5. Bot warned about tracked position not found

Additionally, the swap recovery logic wasn't triggering for "InsufficientCoinBalance" transaction errors.

## Root Cause

### Issue 1: Position Tracking State Management

In `rebalancePosition()`, the code flow was:
1. Remove liquidity from old position → position now has 0 liquidity
2. Call `addLiquidity()` to create new position
3. If `addLiquidity()` throws, catch at line 473
4. **BUG**: `trackedPositionId` still points to old position with 0 liquidity
5. Next cycle: old position is filtered out (0 liquidity), warning logged

The tracking was not being managed properly around the add liquidity operation.

### Issue 2: Insufficient Balance Error Detection

The error pattern matching didn't include "InsufficientCoinBalance" which is the actual error format returned by Sui transactions:

```
Failed to add liquidity: InsufficientCoinBalance in command 1
```

The regex pattern `/insufficient balance/i` didn't match because there's no space between "Insufficient" and "Coin".

## Solution

### Fix 1: Clear and Restore Position Tracking (rebalance.ts:431-498)

```typescript
// Save old tracking and clear before attempting add liquidity
const oldTrackedPositionId = this.trackedPositionId;
const isCreatingNewPosition = !existingInRangePosition && hasLiquidity;

if (isCreatingNewPosition) {
  // Clear tracking temporarily until we confirm new position is created
  this.trackedPositionId = null;
  logger.info('Cleared tracked position ID - will update after successful add liquidity', {
    oldPositionId: oldTrackedPositionId,
  });
}

// Add liquidity with proper error handling
try {
  result = await this.addLiquidity(...);
} catch (addLiquidityError) {
  // Keep tracking cleared - old position has zero liquidity anyway
  if (isCreatingNewPosition) {
    logger.warn('Add liquidity failed after removing liquidity. Tracking cleared to allow recovery.', {
      oldPositionId: oldTrackedPositionId,
      reason: 'Old position has zero liquidity and would be filtered out',
    });
  }
  throw addLiquidityError;
}

// Only update tracking after successful position discovery
if (!existingInRangePosition) {
  const newPos = updatedPositions.find(...);
  if (newPos) {
    this.trackedPositionId = newPos.positionId;
    logger.info('Now tracking newly created position', { positionId: newPos.positionId });
  } else {
    // Keep tracking cleared - allows auto-tracking in next cycle
    logger.warn('Could not find newly created position. Tracking will remain cleared.', {
      oldPositionId: oldTrackedPositionId,
      reason: 'Will allow auto-tracking in next cycle',
    });
  }
}
```

**Key improvements:**
- Extract `isCreatingNewPosition` condition for clarity and maintainability
- Clear `trackedPositionId` before add liquidity when creating new position
- Only restore tracking if position is successfully created
- Keep tracking cleared on failure to allow bot to recover via auto-tracking
- Enhanced logging with old position ID for debugging

**Why not restore old tracking on failure?**
The old position has zero liquidity after removal, so it would be filtered out in subsequent checks anyway. Keeping tracking cleared (null) allows the bot to auto-track the next available position with liquidity.

### Fix 2: Add InsufficientCoinBalance Pattern (rebalance.ts:730)

```typescript
private isInsufficientBalanceError(errorMsg: string): boolean {
  const insufficientPatterns = [
    /insufficient balance/i,
    /insufficientcoinbalance/i, // Matches "InsufficientCoinBalance" from transactions
    /expect\s+\d+/i,
    /amount is insufficient/i,
  ];
  
  return insufficientPatterns.some(pattern => pattern.test(errorMsg));
}
```

This ensures the swap recovery logic is triggered for "InsufficientCoinBalance" errors.

## Testing

### Test Coverage
1. **Position Tracking Tests** (`singlePositionTracking.test.ts`)
   - Verifies range width preservation
   - Validates exact amount rebalancing
   - All tests passing ✅

2. **Insufficient Balance Tests** (`insufficientBalanceRecovery.test.ts`)
   - Added test for "InsufficientCoinBalance" pattern
   - Validates all error patterns
   - All tests passing ✅

3. **Add Liquidity Tests** (`addLiquidityRetry.test.ts`, `addLiquidityFallback.test.ts`)
   - Verifies retry logic
   - Validates fallback behavior
   - All tests passing ✅

### Build Verification
```bash
$ npm run build
> cetus-liquidity-rebalance-bot@1.0.0 build
> tsc
# Build successful with no errors
```

### Security Scan
```bash
$ codeql_checker
Analysis Result for 'javascript'. Found 0 alerts.
```

## Impact

### Before Fix
- Bot gets stuck tracking non-existent positions
- Continuous warning messages every check interval
- No recovery without manual intervention
- Swap recovery not triggered for InsufficientCoinBalance errors

### After Fix
- Bot automatically recovers from failed add liquidity
- Tracking cleared on failure allows auto-tracking in next cycle
- Clean logs with helpful debugging information
- Swap recovery properly triggered for all insufficient balance errors

## Related Files Modified

1. `src/services/rebalance.ts`
   - Lines 431-498: Position tracking management
   - Lines 723-735: Error pattern detection

2. `tests/insufficientBalanceRecovery.test.ts`
   - Lines 28-39: Updated test helper function
   - Lines 97-107: Added InsufficientCoinBalance test cases

## Deployment Notes

This is a bug fix that improves reliability and error recovery. No configuration changes required. The bot will automatically:
- Clear tracking when creating new positions after removing liquidity
- Recover via auto-tracking if position creation fails
- Properly detect and handle InsufficientCoinBalance errors

## Backwards Compatibility

✅ Fully backwards compatible
- No breaking changes to configuration
- No changes to external APIs
- Existing behavior preserved for successful cases
- Only changes failure recovery path
