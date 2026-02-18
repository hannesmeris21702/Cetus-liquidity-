# MoveAbort Error Fix - Balance Refetch Before Add Liquidity

## Problem Statement

The bot was experiencing transaction failures with the following error:
```
[INFO] Token balances are sufficient, proceeding to add liquidity
[ERROR] Add liquidity failed after 3 attempts
[ERROR] Failed to add liquidity: MoveAbort(MoveLocation { 
  module: ModuleId { 
    address: b2db7142fa83210a7d78d9c12ac49c043b3cbbd482224fea6e3da00aa5a5ae2d, 
    name: Identifier("pool_script_v2") 
  }, 
  function: 23, 
  instruction: 29, 
  function_name: Some("repay_add_liquidity") 
}, 0) in command 1
```

## Root Cause Analysis

### The Bug
The `addLiquidity()` method calculates gas-safe balances **once** at the beginning:

```typescript
const balanceABigInt = BigInt(balanceA.totalBalance);
const balanceBBigInt = BigInt(balanceB.totalBalance);
const safeBalanceA = isSuiA && balanceABigInt > SUI_GAS_RESERVE
  ? balanceABigInt - SUI_GAS_RESERVE
  : balanceABigInt;
const safeBalanceB = isSuiB && balanceBBigInt > SUI_GAS_RESERVE
  ? balanceBBigInt - SUI_GAS_RESERVE
  : balanceBBigInt;
```

However, during the rebalance flow:
1. **Remove liquidity** transaction executes → consumes gas
2. **Swap** transaction may execute → consumes more gas
3. Actual balance is now **less** than the initially calculated `safeBalance`
4. Code tries to use the stale `safeBalance` amounts
5. Smart contract aborts with error code 0 (insufficient balance)

### Why It Happens
The `SUI_GAS_RESERVE` only accounts for **one** transaction's gas. But the rebalance flow involves **multiple** transactions:
- Remove liquidity (gas consumed)
- Optional swap (gas consumed)
- Add liquidity (needs gas)

By the time we reach add liquidity, the actual available balance is significantly less than the originally calculated safe balance.

## The Fix

### Solution
Refetch balances **immediately before** building the add liquidity transaction payload:

```typescript
// Refetch balances after all swap operations to get the CURRENT state
// This is critical because remove liquidity and swap transactions consumed gas,
// making the earlier balance calculations stale.
const finalBalances = await Promise.all([
  suiClient.getBalance({
    owner: ownerAddress,
    coinType: poolInfo.coinTypeA,
  }),
  suiClient.getBalance({
    owner: ownerAddress,
    coinType: poolInfo.coinTypeB,
  }),
]);

const finalBalanceA = BigInt(finalBalances[0].totalBalance);
const finalBalanceB = BigInt(finalBalances[1].totalBalance);

// Recalculate safe balances with gas reserve for the upcoming add liquidity transaction
const finalSafeBalanceA = isSuiA && finalBalanceA > SUI_GAS_RESERVE
  ? finalBalanceA - SUI_GAS_RESERVE
  : finalBalanceA;
const finalSafeBalanceB = isSuiB && finalBalanceB > SUI_GAS_RESERVE
  ? finalBalanceB - SUI_GAS_RESERVE
  : finalBalanceB;

// Cap the amounts to the actual available balance after all operations
const amountABigInt = BigInt(amountA);
const amountBBigInt = BigInt(amountB);
const finalAmountA = amountABigInt > finalSafeBalanceA ? finalSafeBalanceA : amountABigInt;
const finalAmountB = amountBBigInt > finalSafeBalanceB ? finalSafeBalanceB : amountBBigInt;

// Update amounts to the final capped values
amountA = finalAmountA.toString();
amountB = finalAmountB.toString();
```

### Why This Works
1. Fetches **actual current** balances after all intermediate transactions
2. Recalculates safe balances with gas reserve for the **next** transaction
3. Caps amounts to what's **actually available** right now
4. Prevents trying to spend more than available → no MoveAbort

## Changes Summary

### Modified File
- `src/services/rebalance.ts` (lines 986-1052)

### What Changed
1. **Added balance refetch** after swap operations complete
2. **Recalculate safe balances** with current actual balances
3. **Cap amounts** to newly calculated safe balances
4. **Enhanced logging** for better debugging

### What Didn't Change
- No changes to core rebalancing logic
- No changes to swap logic
- No changes to position management
- No changes to SDK interactions
- Only added balance refresh step

## Impact

### Before Fix
```
Initial balance: 100 SUI
Reserve for gas: 0.05 SUI
Safe balance calculated: 99.95 SUI

[Remove liquidity] -0.03 SUI gas
Actual balance now: 99.97 SUI

[Swap if needed] -0.02 SUI gas  
Actual balance now: 99.95 SUI

[Try add liquidity with 99.95 SUI]
❌ FAIL - only 99.95 available, need 99.95 + 0.05 gas
MoveAbort error code 0
```

### After Fix
```
Initial balance: 100 SUI
Reserve for gas: 0.05 SUI
Safe balance calculated: 99.95 SUI

[Remove liquidity] -0.03 SUI gas
Actual balance now: 99.97 SUI

[Swap if needed] -0.02 SUI gas  
Actual balance now: 99.95 SUI

🔄 REFETCH BALANCES
Actual balance: 99.95 SUI
Recalculate safe: 99.90 SUI (leave 0.05 for gas)

[Add liquidity with 99.90 SUI]
✅ SUCCESS - 99.90 available, 0.05 reserved for gas
```

## Testing

### Build
```bash
npm install
npm run build
```
✅ Build successful

### Tests
```bash
npm test
```
✅ All tests pass

### Security
```bash
codeql_checker
```
✅ No vulnerabilities found (0 alerts)

### Code Review
✅ Completed with 1 minor style suggestion (acceptable)

## Configuration

No configuration changes required. The fix works with existing settings:
- `GAS_BUDGET` environment variable (default: 50000000)
- All existing pool and token configurations

## Deployment

1. Pull the latest code
2. Run `npm install` (if needed)
3. Run `npm run build`
4. Restart the bot

No breaking changes, backward compatible with existing configurations.

## Summary

This is a **minimal, surgical fix** that solves the MoveAbort error by ensuring balance calculations are fresh and account for all gas consumed during the rebalance flow. The fix adds only 47 lines of code (balance refetch and recalculation) without modifying any existing logic.

**Result**: Bot can now successfully complete rebalance operations without hitting MoveAbort errors due to insufficient balance.
