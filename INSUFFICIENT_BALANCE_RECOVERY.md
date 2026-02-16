# Insufficient Balance Recovery Implementation

## Overview
This implementation adds automatic swap recovery when add liquidity operations fail due to insufficient token balance. When such errors are detected, the bot automatically swaps the opposite token to acquire the missing amount and retries the add liquidity operation once.

## Key Features

### 1. Error Detection
The bot now detects insufficient balance errors by matching these patterns (case-insensitive):
- `"Insufficient balance"` - Direct balance error messages
- `"expect <number>"` - Amount mismatch errors (e.g., "expect 1000, got 500")
- `"amount is Insufficient"` - Alternative insufficient amount messages

### 2. Automatic Balance Analysis
When an insufficient balance error is detected, the bot:
1. Fetches current balances for both tokens
2. Compares with required amounts
3. Identifies which token (A or B) is insufficient
4. Calculates the missing amount

### 3. Smart Swap Recovery
The recovery process:
1. Swaps the opposite token to acquire the missing amount
2. Adds a 10% buffer to the swap amount to account for slippage
3. Validates sufficient balance before attempting the swap
4. Only attempts recovery once per transaction (via `recoveryAttempted` flag)

### 4. Single Retry After Recovery
After a successful swap:
1. Re-fetches the pool state to get the latest price
2. Retries the add liquidity operation once
3. If the retry fails, the error is propagated normally

## Technical Implementation

### New Methods

#### `isInsufficientBalanceError(errorMsg: string): boolean`
Detects if an error message indicates insufficient balance using regex patterns.

#### `calculateSwapAmountWithBuffer(missingAmount: bigint): bigint`
Calculates the swap amount with a 10% buffer for slippage.

#### `attemptSwapRecovery(...): Promise<void>`
Main recovery method that:
- Analyzes balances
- Identifies insufficient token
- Performs the swap using existing `performSwap()` utility
- Validates sufficient balance to perform swap

### Modified Method

#### `addLiquidity(...): Promise<...>`
Enhanced to include recovery logic:
- Wraps transaction execution in try-catch
- Detects insufficient balance errors
- Attempts swap recovery once
- Retries add liquidity after successful swap
- Maintains existing retry loop for other errors

## Compliance with Requirements

✅ **Error Detection**: Matches "Insufficient balance", "expect", and "amount is Insufficient"
✅ **Balance Parsing**: Extracts required, current, and missing amounts
✅ **Token Identification**: Correctly identifies Token A or Token B as insufficient
✅ **Minimal Swap**: Only swaps missing amount + 10% buffer (no overbuying)
✅ **Pool Selection**: Uses existing poolInfo (no changes)
✅ **Single Transaction**: Add liquidity remains in single transaction attempt
✅ **Single Retry**: Retries add liquidity exactly once after swap
✅ **Recovery Flag**: Only attempts recovery once per transaction
✅ **No Breaking Changes**: Existing retry logic, rebalance flow, and bot logic unchanged
✅ **Comprehensive Logging**: Logs all recovery steps with relevant data

## Logging Output

When recovery is triggered, you'll see logs like:

```
[INFO] Executing add liquidity transaction...
[INFO] Insufficient balance detected, attempting swap recovery...
[INFO] Analyzing insufficient balance error...
[INFO] Balance analysis: { currentBalanceA: '1000000', currentBalanceB: '5000000', requiredA: '2000000', requiredB: '4000000' }
[INFO] Insufficient balance detected for Token A: { required: '2000000', current: '1000000', missing: '1000000' }
[INFO] Swapping Token B → Token A: { amount: '1100000' }
[INFO] Executing swap: { direction: 'B→A', amount: '1100000', pool: '0x...' }
[INFO] Swap completed: { digest: '0x...' }
[INFO] Swap recovery completed for Token A
[INFO] Retrying add liquidity after swap recovery...
[INFO] Liquidity added successfully: { digest: '0x...', positionId: '(new position)', amountA: '2000000', amountB: '4000000' }
```

## Testing

### New Test File
`tests/insufficientBalanceRecovery.test.ts` contains 11 comprehensive tests:
1. Error pattern detection for "Insufficient balance"
2. Error pattern detection for "expect <number>"
3. False positive prevention (no generic "expect" matching)
4. Error pattern detection for "amount is Insufficient"
5. Unrelated error rejection
6. Case-insensitive matching
7. Balance analysis and missing amount calculation
8. Swap direction logic
9. Single recovery attempt enforcement
10. Balance validation before swap
11. Real-world error message patterns

### Test Results
All tests pass:
- ✅ New insufficient balance recovery tests (11 tests)
- ✅ Existing add liquidity retry tests (5 tests)
- ✅ Existing swap detection tests (8 tests)
- ✅ Existing rebalance amounts tests (14 tests)

### Security
- ✅ CodeQL security scan: 0 alerts
- ✅ No new vulnerabilities introduced
- ✅ No changes to sensitive operations

## Usage

This feature is automatic and requires no configuration changes. The bot will:
1. Attempt add liquidity as normal
2. If insufficient balance error occurs, automatically swap and retry
3. Log all recovery steps for transparency
4. Continue normal operation if recovery succeeds
5. Fail with the original error if recovery is impossible

## Edge Cases Handled

1. **Neither token insufficient**: Skips recovery (error not balance-related)
2. **Insufficient balance for swap**: Logs clear error message
3. **Recovery already attempted**: Prevents infinite loops
4. **Swap failure**: Logs error and propagates to caller
5. **Retry failure**: Logs error with context

## Code Quality

- Type-safe with TypeScript
- Well-documented with JSDoc comments
- Follows existing code patterns
- Extracted to helper methods for maintainability
- No magic numbers (constants clearly defined)
- Comprehensive error handling

## Maintenance

To adjust the swap buffer percentage, modify the constant in `calculateSwapAmountWithBuffer()`:
```typescript
const SWAP_BUFFER_PERCENTAGE = 110n; // 110% = 10% buffer
```

To adjust error patterns, modify the array in `isInsufficientBalanceError()`:
```typescript
const insufficientPatterns = [
  /insufficient balance/i,
  /expect\s+\d+/i,
  /amount is insufficient/i,
];
```
