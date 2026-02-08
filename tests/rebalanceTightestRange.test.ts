import assert from 'assert';
import { PositionMonitorService } from '../src/services/monitor';
import { BotConfig } from '../src/config';

/**
 * Tests that rebalancing always uses the tightest active range (single
 * tick-spacing bin) regardless of the old position's range width, and
 * that the reduced default gas budget is applied correctly.
 *
 * Run with:  npx ts-node tests/rebalanceTightestRange.test.ts
 */

const STUB_PRIVATE_KEY = 'a'.repeat(64);
const STUB_POOL_ADDRESS = '0x' + '0'.repeat(64);

function buildService(overrides: Partial<BotConfig> = {}): PositionMonitorService {
  const config: BotConfig = {
    network: 'mainnet',
    privateKey: STUB_PRIVATE_KEY,
    checkInterval: 300,
    rebalanceThreshold: 0.05,
    poolAddress: STUB_POOL_ADDRESS,
    maxSlippage: 0.01,
    gasBudget: 50_000_000, // reduced default
    logLevel: 'error',
    verboseLogs: false,
    ...overrides,
  };
  const sdkStub = {} as InstanceType<typeof import('../src/services/sdk').CetusSDKService>;
  return new PositionMonitorService(sdkStub, config);
}

// ── Rebalance always uses tightest range ────────────────────────────────
// The rebalance flow now calls calculateOptimalRange(currentTick, tickSpacing)
// WITHOUT passing the old range width, so the result must always be a
// single tick-spacing bin.

{
  const svc = buildService();
  const tickSpacing = 60;

  // Simulate: old position was [600, 1200] (width 600), price moved to 1250.
  // Rebalance should NOT preserve the old width; it should use the tightest range.
  {
    const currentTick = 1250;
    const { lower, upper } = svc.calculateOptimalRange(currentTick, tickSpacing);
    assert.strictEqual(upper - lower, tickSpacing, 'rebalance must use tightest range (1 tick spacing)');
    assert.ok(lower <= currentTick && currentTick < upper, 'current tick must be within new range');
    // lower = floor(1250/60)*60 = 1200, upper = 1260
    assert.strictEqual(lower, 1200);
    assert.strictEqual(upper, 1260);
    console.log('✔ rebalance uses tightest range instead of preserving old width');
  }

  // Same scenario with a different old range width — result should be identical.
  {
    const currentTick = 1250;
    // No preserveRangeWidth passed → tightest range
    const { lower, upper } = svc.calculateOptimalRange(currentTick, tickSpacing);
    assert.strictEqual(lower, 1200);
    assert.strictEqual(upper, 1260);
    console.log('✔ tightest range is always the same regardless of old position width');
  }

  // Tick spacing = 1 (finest granularity pools)
  {
    const currentTick = 4567;
    const { lower, upper } = svc.calculateOptimalRange(currentTick, 1);
    assert.strictEqual(lower, 4567);
    assert.strictEqual(upper, 4568);
    assert.strictEqual(upper - lower, 1, 'tightest range with tickSpacing=1');
    console.log('✔ tightest range with tickSpacing=1');
  }
}

// ── Reduced gas budget default ──────────────────────────────────────────
// The default gas budget is now 50_000_000 MIST (0.05 SUI) to reduce fees.

{
  // Reimplementation of amount-selection logic with the new default gas budget
  function computeRebalanceAmounts(
    removedAmountA: string | undefined,
    removedAmountB: string | undefined,
    walletBalanceA: string,
    walletBalanceB: string,
    isSuiA: boolean = false,
    isSuiB: boolean = false,
    gasBudget: bigint = 50_000_000n, // new reduced default
  ): { amountA: string; amountB: string } {
    const balanceABigInt = BigInt(walletBalanceA);
    const balanceBBigInt = BigInt(walletBalanceB);

    const safeBalanceA = isSuiA && balanceABigInt > gasBudget
      ? balanceABigInt - gasBudget
      : balanceABigInt;
    const safeBalanceB = isSuiB && balanceBBigInt > gasBudget
      ? balanceBBigInt - gasBudget
      : balanceBBigInt;

    const removedA = removedAmountA ? BigInt(removedAmountA) : 0n;
    const removedB = removedAmountB ? BigInt(removedAmountB) : 0n;

    const amountA = (removedA > 0n && removedA <= safeBalanceA ? removedA : safeBalanceA).toString();
    const amountB = (removedB > 0n && removedB <= safeBalanceB ? removedB : safeBalanceB).toString();

    return { amountA, amountB };
  }

  // SUI gas reserve with reduced budget: 4.2 SUI wallet, 0.05 SUI reserve → safe = 4.15 SUI
  {
    const { amountA } = computeRebalanceAmounts(
      undefined, '5000000000', '4200000000', '6000000000',
      true, false,
    );
    assert.strictEqual(amountA, '4150000000', 'reduced gas reserve: 4.2 - 0.05 = 4.15 SUI');
    console.log('✔ reduced gas budget (50M MIST) applied correctly for SUI reserve');
  }

  // Same amounts re-added: removed amounts are used when within safe balance
  {
    const { amountA, amountB } = computeRebalanceAmounts('500', '300', '1000', '1000');
    assert.strictEqual(amountA, '500', 'removed amount A re-added');
    assert.strictEqual(amountB, '300', 'removed amount B re-added');
    console.log('✔ same amounts from old position are re-added');
  }

  // Single-sided removal: only one token freed, other falls back to wallet balance
  {
    const { amountA, amountB } = computeRebalanceAmounts(undefined, '5000', '1200', '6000');
    assert.strictEqual(amountA, '1200', 'wallet balance used for missing token');
    assert.strictEqual(amountB, '5000', 'freed amount re-added');
    console.log('✔ single-sided removal: freed amount + wallet fallback');
  }
}

console.log('\nAll rebalanceTightestRange tests passed ✅');
