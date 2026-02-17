import * as assert from 'assert';
import { PositionInfo } from '../src/services/monitor';

/**
 * Tests for filtering positions with zero liquidity.
 *
 * Requirements:
 *   1. Track only positions with liquidity > 0
 *   2. Never select positions with zero liquidity
 *   3. Always choose the tracked position with the highest liquidity
 *
 * Run with: npx ts-node tests/zeroLiquidityFiltering.test.ts
 */

// ── Helper function to filter and sort positions ────────────────────────────

function filterAndSelectPosition(positions: PositionInfo[]): PositionInfo | null {
  // Filter positions to only include those with liquidity > 0
  const positionsWithLiquidity = positions.filter(p => 
    p.liquidity != null && 
    BigInt(p.liquidity) > 0n
  );

  if (positionsWithLiquidity.length === 0) {
    return null;
  }

  // Sort by liquidity (highest first) and select the first one
  const sorted = [...positionsWithLiquidity].sort((a, b) => {
    const liqA = BigInt(a.liquidity || '0');
    const liqB = BigInt(b.liquidity || '0');
    if (liqA > liqB) return -1;
    if (liqA < liqB) return 1;
    return 0;
  });

  return sorted[0];
}

// ── Test 1: Filter out positions with zero liquidity ────────────────────────

{
  const positions: PositionInfo[] = [
    {
      positionId: 'pos1',
      poolAddress: '0xpool',
      tickLower: 100,
      tickUpper: 200,
      liquidity: '0', // zero liquidity
      tokenA: '0xA',
      tokenB: '0xB',
      inRange: true,
    },
    {
      positionId: 'pos2',
      poolAddress: '0xpool',
      tickLower: 150,
      tickUpper: 250,
      liquidity: '1000000', // has liquidity
      tokenA: '0xA',
      tokenB: '0xB',
      inRange: true,
    },
  ];

  const selected = filterAndSelectPosition(positions);
  assert.ok(selected !== null, 'should select a position');
  assert.strictEqual(selected!.positionId, 'pos2', 'should select position with non-zero liquidity');
  assert.notStrictEqual(selected!.positionId, 'pos1', 'should not select position with zero liquidity');
  console.log('✔ positions with zero liquidity are filtered out');
}

// ── Test 2: Select position with highest liquidity ──────────────────────────

{
  const positions: PositionInfo[] = [
    {
      positionId: 'pos1',
      poolAddress: '0xpool',
      tickLower: 100,
      tickUpper: 200,
      liquidity: '500000',
      tokenA: '0xA',
      tokenB: '0xB',
      inRange: true,
    },
    {
      positionId: 'pos2',
      poolAddress: '0xpool',
      tickLower: 150,
      tickUpper: 250,
      liquidity: '2000000', // highest liquidity
      tokenA: '0xA',
      tokenB: '0xB',
      inRange: true,
    },
    {
      positionId: 'pos3',
      poolAddress: '0xpool',
      tickLower: 200,
      tickUpper: 300,
      liquidity: '1000000',
      tokenA: '0xA',
      tokenB: '0xB',
      inRange: true,
    },
  ];

  const selected = filterAndSelectPosition(positions);
  assert.ok(selected !== null, 'should select a position');
  assert.strictEqual(selected!.positionId, 'pos2', 'should select position with highest liquidity');
  console.log('✔ position with highest liquidity is selected');
}

// ── Test 3: Return null when all positions have zero liquidity ──────────────

{
  const positions: PositionInfo[] = [
    {
      positionId: 'pos1',
      poolAddress: '0xpool',
      tickLower: 100,
      tickUpper: 200,
      liquidity: '0',
      tokenA: '0xA',
      tokenB: '0xB',
      inRange: true,
    },
    {
      positionId: 'pos2',
      poolAddress: '0xpool',
      tickLower: 150,
      tickUpper: 250,
      liquidity: '0',
      tokenA: '0xA',
      tokenB: '0xB',
      inRange: true,
    },
  ];

  const selected = filterAndSelectPosition(positions);
  assert.strictEqual(selected, null, 'should return null when all positions have zero liquidity');
  console.log('✔ null returned when all positions have zero liquidity');
}

// ── Test 4: Handle null/undefined liquidity values ──────────────────────────

{
  const positions: PositionInfo[] = [
    {
      positionId: 'pos1',
      poolAddress: '0xpool',
      tickLower: 100,
      tickUpper: 200,
      liquidity: '', // empty string (invalid)
      tokenA: '0xA',
      tokenB: '0xB',
      inRange: true,
    },
    {
      positionId: 'pos2',
      poolAddress: '0xpool',
      tickLower: 150,
      tickUpper: 250,
      liquidity: '1000000', // valid liquidity
      tokenA: '0xA',
      tokenB: '0xB',
      inRange: true,
    },
  ];

  const selected = filterAndSelectPosition(positions);
  assert.ok(selected !== null, 'should select a position');
  assert.strictEqual(selected!.positionId, 'pos2', 'should select position with valid liquidity');
  console.log('✔ positions with invalid liquidity values are filtered out');
}

// ── Test 5: Mixed zero and non-zero liquidity positions ─────────────────────

{
  const positions: PositionInfo[] = [
    {
      positionId: 'pos1',
      poolAddress: '0xpool',
      tickLower: 100,
      tickUpper: 200,
      liquidity: '0',
      tokenA: '0xA',
      tokenB: '0xB',
      inRange: true,
    },
    {
      positionId: 'pos2',
      poolAddress: '0xpool',
      tickLower: 150,
      tickUpper: 250,
      liquidity: '3000000', // highest
      tokenA: '0xA',
      tokenB: '0xB',
      inRange: false,
    },
    {
      positionId: 'pos3',
      poolAddress: '0xpool',
      tickLower: 200,
      tickUpper: 300,
      liquidity: '0',
      tokenA: '0xA',
      tokenB: '0xB',
      inRange: true,
    },
    {
      positionId: 'pos4',
      poolAddress: '0xpool',
      tickLower: 250,
      tickUpper: 350,
      liquidity: '100000',
      tokenA: '0xA',
      tokenB: '0xB',
      inRange: true,
    },
  ];

  const selected = filterAndSelectPosition(positions);
  assert.ok(selected !== null, 'should select a position');
  assert.strictEqual(selected!.positionId, 'pos2', 'should select position with highest non-zero liquidity');
  assert.strictEqual(selected!.liquidity, '3000000', 'selected position should have the highest liquidity');
  console.log('✔ correctly selects highest liquidity position from mixed zero/non-zero positions');
}

console.log('\n✅ All zero liquidity filtering tests passed!');
