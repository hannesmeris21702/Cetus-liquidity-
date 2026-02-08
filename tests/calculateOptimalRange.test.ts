import assert from 'assert';
import { PositionMonitorService } from '../src/services/monitor';
import { BotConfig } from '../src/config';

/**
 * Lightweight tests for PositionMonitorService.calculateOptimalRange().
 * Run with: npx ts-node tests/calculateOptimalRange.test.ts
 */

// Minimal stubs – only the config fields that calculateOptimalRange reads are needed.
const STUB_PRIVATE_KEY = 'a'.repeat(64); // fake key for test config only
const STUB_POOL_ADDRESS = '0x' + '0'.repeat(64); // 32-byte Sui address

function buildService(overrides: Partial<BotConfig> = {}): PositionMonitorService {
  const config: BotConfig = {
    network: 'mainnet',
    privateKey: STUB_PRIVATE_KEY,
    checkInterval: 300,
    rebalanceThreshold: 0.05,
    poolAddress: STUB_POOL_ADDRESS,
    maxSlippage: 0.01,
    gasBudget: 100_000_000,
    logLevel: 'error',
    verboseLogs: false,
    ...overrides,
  };
  // sdkService is not used by calculateOptimalRange so we pass a stub
  const sdkStub = {} as InstanceType<typeof import('../src/services/sdk').CetusSDKService>;
  return new PositionMonitorService(sdkStub, config);
}

// ── Tightest-range default (no rangeWidth configured) ───────────────────

{
  const svc = buildService(); // no rangeWidth
  const tickSpacing = 60;

  // currentTick in the middle of a bin
  {
    const { lower, upper } = svc.calculateOptimalRange(1000, tickSpacing);
    assert.strictEqual(lower, 960, 'lower should be floor(1000/60)*60 = 960');
    assert.strictEqual(upper, 1020, 'upper should be 960 + 60 = 1020');
    assert.ok(upper - lower === tickSpacing, 'range width should equal tickSpacing');
    console.log('✔ tightest range – mid-bin');
  }

  // currentTick exactly on a tick boundary
  {
    const { lower, upper } = svc.calculateOptimalRange(1200, tickSpacing);
    assert.strictEqual(lower, 1200);
    assert.strictEqual(upper, 1260);
    console.log('✔ tightest range – on boundary');
  }

  // negative tick
  {
    const { lower, upper } = svc.calculateOptimalRange(-100, tickSpacing);
    // Math.floor(-100/60) = -2 → lower = -120, upper = -60
    assert.strictEqual(lower, -120);
    assert.strictEqual(upper, -60);
    assert.ok(lower <= -100 && -100 < upper, 'currentTick must be in [lower, upper)');
    console.log('✔ tightest range – negative tick');
  }

  // tick spacing = 1 (finest granularity)
  {
    const { lower, upper } = svc.calculateOptimalRange(500, 1);
    assert.strictEqual(lower, 500);
    assert.strictEqual(upper, 501);
    console.log('✔ tightest range – tickSpacing=1');
  }
}

// ── Explicit rangeWidth preserves centred behaviour ─────────────────────

{
  const svc = buildService({ rangeWidth: 600 }); // 10× tickSpacing of 60
  const { lower, upper } = svc.calculateOptimalRange(1000, 60);
  // ticksBelow = 300, ticksAbove = 300
  // lower = floor((1000-300)/60)*60 = floor(700/60)*60 = 660
  // upper = ceil((1000+300)/60)*60  = ceil(1300/60)*60  = 1320
  assert.strictEqual(lower, 660);
  assert.strictEqual(upper, 1320);
  console.log('✔ explicit rangeWidth – centred range preserved');
}

console.log('\nAll calculateOptimalRange tests passed ✅');
