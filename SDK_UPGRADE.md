# SDK Upgrade - v4.3.2 to v5.4.0

## Issue Summary

The bot was experiencing transaction failures with the following error:
```
MoveAbort(MoveLocation { module: ModuleId { address: 0x70968826ad1b4ba895753f634b0aea68d0672908ca1075a2abdf0fc6a, name: Identifier("config") }, function: 24, instruction: 8, function_name: Some("checked_package_version") }, 10)
```

This error indicated a **package version mismatch** between the SDK and the current Cetus protocol on-chain contracts.

## Root Cause

After the Cetus protocol exploit in 2025 and subsequent recovery upgrade, the Cetus protocol contracts were upgraded on Sui mainnet. The bot was using SDK version 4.3.2, which contained outdated package addresses that no longer matched the deployed protocol version.

## Solution

### 1. Upgraded SDK
- **Old Version**: `@cetusprotocol/cetus-sui-clmm-sdk@4.3.2`
- **New Version**: `@cetusprotocol/cetus-sui-clmm-sdk@5.4.0`

### 2. Updated SDK Initialization
Replaced manual configuration with the official `initCetusSDK` helper:

**Before:**
```typescript
import { CetusClmmSDK } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { getSDKConfig } from '../config/sdkConfig';

const sdkConfig = getSDKConfig(config.network);
const sdk = new CetusClmmSDK({
  ...sdkConfig,
  fullRpcUrl: rpcUrl,
  simulationAccount: { address },
});
```

**After:**
```typescript
import { CetusClmmSDK, initCetusSDK } from '@cetusprotocol/cetus-sui-clmm-sdk';

const sdk = initCetusSDK({
  network: config.network,
  fullNodeUrl: rpcUrl,
  wallet: address,
});
```

### 3. Benefits of New Approach
- ✅ Always uses latest on-chain package addresses
- ✅ No need to manually maintain package IDs
- ✅ Automatic compatibility with protocol upgrades
- ✅ Simplified configuration

## Files Changed

1. **package.json**
   - Updated SDK dependency from `^4.3.2` to `^5.4.0`

2. **src/services/sdk.ts**
   - Removed import of `getSDKConfig` from `../config/sdkConfig`
   - Added import of `initCetusSDK` helper
   - Simplified SDK initialization using `initCetusSDK()`
   - Changed `simulationAccount` to `wallet` (API change in v5)

3. **src/config/sdkConfig.ts**
   - This file is now deprecated and can be removed in future cleanup
   - The hardcoded package addresses are no longer used

## Testing

After the upgrade, the bot should:
1. ✅ Initialize successfully
2. ✅ Connect to the correct protocol version
3. ✅ Execute transactions without version errors
4. ✅ Successfully rebalance positions

## Migration Notes for Developers

If you're maintaining this codebase or similar bots:

1. **Always use `initCetusSDK`**: This ensures you get the latest package addresses automatically.

2. **SDK Version Updates**: The SDK now follows semantic versioning more strictly. Major version bumps (4.x → 5.x) may include breaking API changes.

3. **API Changes in v5**:
   - `simulationAccount` parameter renamed to `wallet`
   - Some transaction payload methods may have updated signatures

4. **Best Practice**: Pin to a specific minor version range (e.g., `^5.4.0`) but stay updated on patch releases for bug fixes and security updates.

## References

- [Cetus SDK Repository](https://github.com/CetusProtocol/cetus-clmm-sui-sdk)
- [Cetus Developer Documentation](https://cetus-1.gitbook.io/cetus-developer-docs/)
- [SDK Version 5.4.0 on NPM](https://www.npmjs.com/package/@cetusprotocol/cetus-sui-clmm-sdk)

## Date
February 7, 2026
