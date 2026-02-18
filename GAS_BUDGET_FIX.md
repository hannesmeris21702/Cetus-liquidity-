# Gas Budget Fix Documentation

## Problem
The bot was failing with the following error:
```
[ERROR] Add liquidity failed after 3 attempts
[ERROR] Failed to add liquidity: Dry run failed, could not automatically determine a budget: 
MoveAbort(MoveLocation { module: ModuleId { address: b2db7142fa83210a7d78d9c12ac49c043b3cbbd482224fea6e3da00aa5a5ae2d, 
name: Identifier("pool_script_v2") }, function: 23, instruction: 29, function_name: Some("repay_add_liquidity") }, 0) 
in command 1
```

## Root Cause
All Sui blockchain transaction executions in the rebalance service were missing explicit gas budget configuration. The Sui client requires a gas budget to be set on transaction objects before execution, especially for complex operations like liquidity management.

## Solution
Added `setGasBudget(this.config.gasBudget)` call on all transaction payloads before signing and executing them. This ensures the Sui client can properly simulate and execute the transactions.

### Changes Made
The following transaction types now have gas budgets set:
1. **Remove Liquidity** - Line 453 in `src/services/rebalance.ts`
2. **Swap** - Line 784 in `src/services/rebalance.ts`
3. **Add Liquidity (main)** - Line 1107 in `src/services/rebalance.ts`
4. **Add Liquidity (recovery)** - Line 1155 in `src/services/rebalance.ts`
5. **Add Liquidity (new position)** - Line 1297 in `src/services/rebalance.ts`

## Configuration
The gas budget is configured via the `GAS_BUDGET` environment variable in your `.env` file:

```bash
GAS_BUDGET=50000000  # Default: 50 MIST (0.05 SUI)
```

You can adjust this value based on:
- Network congestion
- Transaction complexity
- Your risk tolerance

### Recommended Values
- **Mainnet**: 50000000-100000000 MIST (0.05-0.1 SUI)
- **Testnet**: 50000000 MIST (0.05 SUI)

## How to Use

### 1. Build the code
```bash
npm install
npm run build
```

### 2. Configure your environment
Make sure your `.env` file has the correct settings:
```bash
# Required
PRIVATE_KEY=your_private_key
POOL_ID=your_pool_id
RPC_URL=https://fullnode.mainnet.sui.io:443

# Optional (with defaults)
GAS_BUDGET=50000000
MAX_SLIPPAGE=0.01
CHECK_INTERVAL=30
```

### 3. Run the bot
```bash
npm start
```

## Verification
After applying this fix, the bot should:
1. Successfully execute remove liquidity transactions
2. Successfully execute add liquidity transactions
3. No longer fail with "Dry run failed" errors
4. Complete rebalance operations without transaction simulation failures

## No Logic Changes
This fix **only** adds gas budget configuration to transactions. No bot logic, trading strategy, or position management logic was changed.

## Troubleshooting

### If you still see "Dry run failed" errors:
1. **Increase gas budget**: Try setting `GAS_BUDGET=100000000` (0.1 SUI)
2. **Check RPC endpoint**: Ensure your RPC_URL is responsive
3. **Verify network status**: Check Sui network status for any ongoing issues
4. **Check balances**: Ensure you have sufficient SUI for gas fees

### If transactions fail with "Insufficient gas":
1. Increase the `GAS_BUDGET` value in your `.env` file
2. Ensure your wallet has enough SUI balance for gas

## Technical Details
The fix leverages the Sui SDK's `Transaction.setGasBudget()` method which is called on transaction payload objects returned by the Cetus SDK before signing and execution.

**Before:**
```typescript
const payload = await sdk.Position.createAddLiquidityFixTokenPayload(params, options);
const result = await suiClient.signAndExecuteTransaction({
  transaction: payload,
  signer: keypair,
  options: { showEffects: true },
});
```

**After:**
```typescript
const payload = await sdk.Position.createAddLiquidityFixTokenPayload(params, options);
payload.setGasBudget(this.config.gasBudget);  // Set explicit gas budget
const result = await suiClient.signAndExecuteTransaction({
  transaction: payload,
  signer: keypair,
  options: { showEffects: true },
});
```

This ensures the Sui client can properly estimate and allocate gas for transaction execution.
