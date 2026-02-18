# Fix for U64 Tick Value Error

## Problem Statement

The liquidity bot was failing with the following error:
```
Invalid u64 value: -1141204. Expected value in range 0-18446744073709551615
```

This error occurred during the "Adding liquidity" phase when the bot attempted to rebalance positions.

## Root Cause

The error was caused by passing negative tick values as numbers to the Cetus SDK's `createAddLiquidityFixTokenPayload` function.

**Why negative ticks are valid:**
- In CLMM (Concentrated Liquidity Market Maker) pools, tick indices can be negative
- Negative ticks represent prices below 1.0 (the reference price)
- This is a standard feature of Uniswap V3-style concentrated liquidity pools

**Why the error occurred:**
- The SDK's `createAddLiquidityFixTokenPayload` accepts `tick_lower` and `tick_upper` as `string | number`
- When negative values were passed as numbers, the SDK's internal serialization attempted to convert them to `u64` (unsigned 64-bit integer)
- u64 can only represent values from 0 to 18,446,744,073,709,551,615
- Negative values cannot be represented in u64, causing the conversion to fail

## Solution

The fix converts tick values to strings before passing them to the SDK:

```typescript
// Before (causing error with negative ticks)
tick_lower: tickLower,  // e.g., -1141204
tick_upper: tickUpper,

// After (works with negative ticks)
tick_lower: String(tickLower),  // e.g., "-1141204"
tick_upper: String(tickUpper),
```

When tick values are provided as strings, the SDK properly handles the serialization of negative values without attempting to convert them to u64.

## Changes Made

### 1. Updated Type Definition
File: `src/services/rebalance.ts`

Changed the `AddLiquidityFixTokenParams` interface to match the SDK's type definition:

```typescript
interface AddLiquidityFixTokenParams {
  // ... other fields ...
  tick_lower: string | number;  // Was: number
  tick_upper: string | number;  // Was: number
  // ... other fields ...
}
```

### 2. Convert Ticks to Strings
File: `src/services/rebalance.ts`

Updated two locations where `createAddLiquidityFixTokenPayload` is called:

**Location 1: Main add liquidity function (line ~1067)**
```typescript
const addLiquidityParams: AddLiquidityFixTokenParams = {
  pool_id: poolInfo.poolAddress,
  pos_id: positionId,
  tick_lower: String(tickLower),  // Convert to string
  tick_upper: String(tickUpper),  // Convert to string
  // ... other params ...
};
```

**Location 2: Fallback recovery with new position (line ~1265)**
```typescript
const newPositionParams: AddLiquidityFixTokenParams = {
  pool_id: poolInfo.poolAddress,
  pos_id: '',
  tick_lower: String(tickLower),  // Convert to string
  tick_upper: String(tickUpper),  // Convert to string
  // ... other params ...
};
```

### 3. Added Test Coverage
File: `tests/negativeTicks.test.ts`

Created a new test to verify correct handling of:
- Positive tick values
- Negative tick values (including the specific -1141204 from the error)
- Zero tick value
- Large negative tick values
- Round-trip conversion (string → number → string)

## Verification

### Build Status
✅ TypeScript compilation successful with no errors

### Test Results
✅ All existing tests pass:
- calculateOptimalRange (including negative tick test)
- addLiquidityRetry
- insufficientBalanceRecovery
- liquidityPreservation
- liquidityValuePreservation
- positionRangeCheck
- rebalanceAmounts
- rebalanceTightestRange
- removeLiquidityAbort
- retryAndNetworkError
- singlePositionTracking
- swapDetection
- tokenBalanceValidation
- zeroLiquidityFiltering

✅ New test passes:
- negativeTicks (specifically validates the fix)

### Code Review
✅ Code review completed with all feedback addressed

### Security Scan
✅ CodeQL scan found 0 security issues

## Impact

### What Changed
- Tick values are now converted to strings before being passed to the SDK
- Type definition updated to match SDK expectations

### What Didn't Change
- **No bot logic changes**: The rebalancing strategy, liquidity management, and all business logic remain unchanged
- **No behavioral changes**: The bot operates exactly the same way, just with proper handling of negative ticks
- **No performance impact**: String conversion is a trivial operation with negligible overhead

## Compatibility

This fix is fully compatible with:
- ✅ Positive tick values (normal operation)
- ✅ Negative tick values (now works correctly)
- ✅ Zero tick value
- ✅ All Cetus SDK versions that accept `string | number` for tick parameters
- ✅ Both mainnet and testnet deployments

## Technical Details

### Why Strings Work
The Sui blockchain's Move language and serialization format handle signed integers differently than u64. When the SDK receives tick values as strings:
1. It preserves the sign information
2. It serializes them using the appropriate Move type (likely i32 or i64)
3. The negative values are correctly represented on-chain

### SDK Type Definition
From `@cetusprotocol/cetus-sui-clmm-sdk`:
```typescript
type AddLiquidityCommonParams = {
    tick_lower: string | number;
    tick_upper: string | number;
    // ...
}
```

The SDK explicitly supports both types, but only strings work correctly for negative values due to the internal u64 conversion issue when using numbers.

## Conclusion

This minimal fix resolves the u64 conversion error by leveraging the SDK's existing support for string tick values. The bot can now properly handle positions with negative tick indices, which are common in pools where assets trade below the reference price.

No bot logic was changed, ensuring the rebalancing strategy and liquidity management behavior remain exactly as designed.
