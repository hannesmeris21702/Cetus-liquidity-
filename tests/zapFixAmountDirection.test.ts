/**
 * Tests for the postZapFixAmountA fix.
 *
 * After a zap-in swap (performed to obtain both tokens for an in-range position),
 * the output token of the swap has slightly LESS than the "ideal" balanced amount
 * due to swap fees/slippage.  fix_amount_a must therefore be set based on the
 * SWAP DIRECTION (fixing the output token) rather than on which token has the
 * larger balance.
 *
 * Root cause of the bug (from the error log):
 *   "The amount(2462265) is Insufficient balance for USDC, expect 2500000"
 *
 *   - Pre-swap estimated 2500000 USDC output; actual received was 2462265.
 *   - amountA=2500000 (remaining), amountB=2462265 (received B from swap).
 *   - OLD: fix_amount_a = amountA >= amountB → true → SDK fixes A at 2500000,
 *     computes required B = 2500000, but wallet only has 2462265 → FAIL.
 *   - NEW: after aToB swap, postZapFixAmountA = !true = false → fix B at 2462265,
 *     SDK computes required A ≈ 2462265 ≤ 2500000 (available) → OK.
 *
 * Run with: npx ts-node tests/zapFixAmountDirection.test.ts
 */

import assert from 'assert';

/**
 * Simulate determineFixAmountA for the in-range case (the logic that was broken).
 */
function determineFixAmountA_inRange(amountA: string, amountB: string): boolean {
  // Original (buggy) logic:
  return BigInt(amountA) >= BigInt(amountB);
}

/**
 * Simulate the new postZapFixAmountA logic.
 *
 * When a zap-in swap is performed, fix_amount_a is set to !aToB so that
 * the SDK fixes on the OUTPUT token and computes the counterpart from it.
 */
function computePostZapFixAmountA(aToB: boolean): boolean {
  return !aToB;
}

/**
 * Simulate whether the resulting fix_amount_a could cause an insufficient-balance
 * error, given the actual post-swap balances and a pool price ratio P (B per A).
 *
 * When fix_amount_a=true (fixing A), the SDK computes required_B = amountA * P.
 * When fix_amount_a=false (fixing B), the SDK computes required_A = amountB / P.
 * The error occurs when the computed counterpart exceeds the available balance.
 */
function wouldFailInsufficientBalance(
  amountA: bigint,
  amountB: bigint,
  fixAmountA: boolean,
  priceP: number,  // B per A
): boolean {
  if (fixAmountA) {
    const requiredB = BigInt(Math.ceil(Number(amountA) * priceP));
    return requiredB > amountB;
  } else {
    const requiredA = BigInt(Math.ceil(Number(amountB) / priceP));
    return requiredA > amountA;
  }
}

console.log('Running postZapFixAmountA direction tests...\n');

// ── The exact failing scenario from the problem statement ─────────────────

// "The amount(2462265) is Insufficient balance for USDC, expect 2500000"
// Pool price ≈ 1:1 (USDC/USDC).
// After aToB swap: amountA = 2500000, amountB = 2462265.
{
  const amountA = 2500000n;
  const amountB = 2462265n;
  const aToB = true;
  const priceP = 1.0; // 1:1

  const oldFix = determineFixAmountA_inRange(amountA.toString(), amountB.toString());
  const newFix = computePostZapFixAmountA(aToB);

  // Old logic: fix A → requires B = 2500000 > 2462265 → FAIL
  assert.strictEqual(oldFix, true, 'OLD: fixes A (larger)');
  assert.strictEqual(
    wouldFailInsufficientBalance(amountA, amountB, oldFix, priceP),
    true,
    'OLD: would fail with insufficient balance',
  );

  // New logic: fix B (output) → requires A ≈ 2462265 ≤ 2500000 → OK
  assert.strictEqual(newFix, false, 'NEW: fixes B (output token)');
  assert.strictEqual(
    wouldFailInsufficientBalance(amountA, amountB, newFix, priceP),
    false,
    'NEW: would NOT fail with insufficient balance',
  );

  console.log('✔ Exact failing scenario: aToB=true, 1:1 price, amountA=2500000 amountB=2462265 → fix B (new) vs fix A (old)');
}

// ── aToB swap with P > 1 (e.g. 1 A = 2 B) ────────────────────────────────

// After swapping half of A: amountA = 2500000 (remaining), amountB = 4975000 (received)
// (fee causes amountB to be slightly less than 5000000 = 2500000 × 2)
{
  const amountA = 2500000n;
  const amountB = 4975000n; // 2500000 * 2 * (1 - 0.005 fee)
  const aToB = true;
  const priceP = 2.0; // 1 A = 2 B

  const oldFix = determineFixAmountA_inRange(amountA.toString(), amountB.toString());
  const newFix = computePostZapFixAmountA(aToB);

  // Old logic: amountA(2500000) < amountB(4975000) → fixes B (smaller) → requires A = 4975000/2 = 2487500 ≤ 2500000 → OK
  // Both old and new logic agree here (both fix B), but the new logic is correct *by design*,
  // not by coincidence: aToB → fix B (output) is always the right choice regardless of amounts.
  assert.strictEqual(oldFix, false, 'OLD: fixes B (smaller — coincidentally same direction as new)');
  // New logic: fix B (output of aToB) → requires A = 4975000/2 = 2487500 ≤ 2500000 → OK
  assert.strictEqual(newFix, false, 'NEW: fixes B (output)');
  assert.strictEqual(
    wouldFailInsufficientBalance(amountA, amountB, newFix, priceP),
    false,
    'NEW: would NOT fail with P=2',
  );
  console.log('✔ aToB swap, P=2: fix B (output) → required A ≤ available A');
}

// ── aToB swap with P < 1 (e.g. 1 A = 0.5 B) ─────────────────────────────

// After swapping half of A: amountA = 2500000 (remaining), amountB = 1244000 (received ≈ 2500000*0.5*(1-fee))
{
  const amountA = 2500000n;
  const amountB = 1244000n; // 2500000 * 0.5 * (1 - 0.005 fee)
  const aToB = true;
  const priceP = 0.5; // 1 A = 0.5 B

  const oldFix = determineFixAmountA_inRange(amountA.toString(), amountB.toString());
  const newFix = computePostZapFixAmountA(aToB);

  // Old logic: amountA(2500000) >= amountB(1244000) → fix A → requires B = 2500000*0.5 = 1250000 > 1244000 → FAIL
  assert.strictEqual(oldFix, true, 'OLD: fixes A (larger)');
  assert.strictEqual(
    wouldFailInsufficientBalance(amountA, amountB, oldFix, priceP),
    true,
    'OLD: would fail with insufficient balance when P=0.5',
  );

  // New logic: fix B (output) → requires A = 1244000/0.5 = 2488000 ≤ 2500000 → OK
  assert.strictEqual(newFix, false, 'NEW: fixes B (output)');
  assert.strictEqual(
    wouldFailInsufficientBalance(amountA, amountB, newFix, priceP),
    false,
    'NEW: would NOT fail when P=0.5',
  );
  console.log('✔ aToB swap, P=0.5: fix B (output) → required A ≤ available A');
}

// ── bToA swap ────────────────────────────────────────────────────────────

// Wallet starts with 5000000 B, no A.
// P = 2 (1 A = 2 B, i.e., 1 B = 0.5 A).
// Swap half B (2500000 B) → receive 2500000/2*(1-0.005) = 1243750 A.
// After swap: amountA = 1243750 (received), amountB = 2500000 (remaining).
{
  const amountA = 1243750n; // received A (output)
  const amountB = 2500000n; // remaining B
  const aToB = false; // B→A
  const priceP = 2.0; // 1 A = 2 B

  const oldFix = determineFixAmountA_inRange(amountA.toString(), amountB.toString());
  const newFix = computePostZapFixAmountA(aToB);

  // Old logic: amountA(1243750) < amountB(2500000) → fix B (false) → requires A = 2500000/2 = 1250000 > 1243750 → FAIL
  assert.strictEqual(oldFix, false, 'OLD: fixes B (amountA < amountB)');
  assert.strictEqual(
    wouldFailInsufficientBalance(amountA, amountB, oldFix, priceP),
    true,
    'OLD: would fail — required A exceeds received A (fee causes shortfall)',
  );

  // New logic: fix A (output of bToA) → requires B = 1243750*2 = 2487500 ≤ 2500000 → OK
  assert.strictEqual(newFix, true, 'NEW: fixes A (output of B→A swap)');
  assert.strictEqual(
    wouldFailInsufficientBalance(amountA, amountB, newFix, priceP),
    false,
    'NEW: succeeds — required B ≤ available remaining B',
  );
  console.log('✔ bToA swap, P=2: fix A (output) → required B ≤ available B');
}

// ── bToA swap with P = 0.5 ────────────────────────────────────────────────

// Wallet starts with 5000000 B, no A.
// P = 0.5 (1 A = 0.5 B).
// Swap half B (2500000 B) → receive 2500000/0.5*(1-0.005) = 4975000 A.
// After swap: amountA = 4975000 (received), amountB = 2500000 (remaining).
{
  const amountA = 4975000n; // received A (output)
  const amountB = 2500000n; // remaining B
  const aToB = false; // B→A
  const priceP = 0.5; // 1 A = 0.5 B

  const oldFix = determineFixAmountA_inRange(amountA.toString(), amountB.toString());
  const newFix = computePostZapFixAmountA(aToB);

  // Old logic: amountA(4975000) >= amountB(2500000) → fixes A → requires B = 4975000*0.5 = 2487500 ≤ 2500000 → OK
  // Both old and new agree here, but new is correct by design: bToA → fix A (output).
  assert.strictEqual(oldFix, true, 'OLD: fixes A (larger — coincidentally same direction as new)');
  assert.strictEqual(
    wouldFailInsufficientBalance(amountA, amountB, oldFix, priceP),
    false,
    'OLD: works at P=0.5',
  );

  // New logic: fix A (output of B→A) → same result → OK
  assert.strictEqual(newFix, true, 'NEW: fixes A (output of B→A swap)');
  assert.strictEqual(
    wouldFailInsufficientBalance(amountA, amountB, newFix, priceP),
    false,
    'NEW: also works at P=0.5',
  );
  console.log('✔ bToA swap, P=0.5: fix A (output) → required B ≤ available B');
}

// ── Price exactly 1:1 with fees causing imbalance (the critical case) ─────

// This is the scenario from the problem statement.
// Wallet has 5000000 A, no B. P = 1.0. Swap 2500000 A → receive 2462265 B (0.5% fee).
// After swap: amountA = 2500000, amountB = 2462265.
{
  const amountA = 2500000n;
  const amountB = 2462265n;
  const aToB = true;
  const priceP = 1.0;

  const oldFix = determineFixAmountA_inRange(amountA.toString(), amountB.toString());
  const newFix = computePostZapFixAmountA(aToB);

  assert.strictEqual(oldFix, true,  'OLD: fixes A (2500000 >= 2462265)');
  assert.strictEqual(newFix, false, 'NEW: fixes B (output token of aToB)');

  const oldFails = wouldFailInsufficientBalance(amountA, amountB, oldFix, priceP);
  const newFails = wouldFailInsufficientBalance(amountA, amountB, newFix, priceP);

  assert.strictEqual(oldFails, true,  'OLD: insufficient balance error (requiredB=2500000 > 2462265)');
  assert.strictEqual(newFails, false, 'NEW: no error (requiredA=2462265 ≤ 2500000)');

  console.log('✔ Critical case (problem statement): OLD fails, NEW succeeds');
}

// ── No zap swap performed (postZapFixAmountA is undefined) ────────────────

// When both tokens are already available (no zap needed), postZapFixAmountA
// stays undefined and determineFixAmountA() is used.
{
  const postZapFixAmountA: boolean | undefined = undefined;
  // Simulate: if postZapFixAmountA is undefined, use determineFixAmountA
  const amountA = '1000000';
  const amountB = '2000000';
  const isInRange = true;
  const tickIndex = 100;
  const tickLower = 50;
  const tickUpper = 200;

  const wouldUseZapOverride = isInRange && postZapFixAmountA !== undefined;
  assert.strictEqual(wouldUseZapOverride, false, 'No zap → should use determineFixAmountA');
  console.log('✔ No zap swap: postZapFixAmountA=undefined → falls back to determineFixAmountA');
}

// ── Price moves out of range between zap and retry ────────────────────────

// If the price moves out of range after the zap but before the retry,
// the retry should use range-based fix_amount_a (not postZapFixAmountA).
{
  const postZapFixAmountA: boolean | undefined = false; // set after aToB swap
  const tickLower = 100;
  const tickUpper = 200;

  // Price still in range
  const freshTickInRange = 150;
  const freshInRange1 = freshTickInRange >= tickLower && freshTickInRange < tickUpper;
  const fixForInRange = (freshInRange1 && postZapFixAmountA !== undefined)
    ? postZapFixAmountA
    : true; // determineFixAmountA for in-range default
  assert.strictEqual(fixForInRange, false, 'In-range retry: uses postZapFixAmountA');

  // Price moved below range
  const freshTickBelow = 50;
  const freshInRange2 = freshTickBelow >= tickLower && freshTickBelow < tickUpper;
  const fixForBelowRange = (freshInRange2 && postZapFixAmountA !== undefined)
    ? postZapFixAmountA
    : true; // determineFixAmountA returns true for below-range
  assert.strictEqual(fixForBelowRange, true, 'Below-range retry: falls back to range logic (fix A)');

  // Price moved above range
  const freshTickAbove = 250;
  const freshInRange3 = freshTickAbove >= tickLower && freshTickAbove < tickUpper;
  const fixForAboveRange = (freshInRange3 && postZapFixAmountA !== undefined)
    ? postZapFixAmountA
    : false; // determineFixAmountA returns false for above-range
  assert.strictEqual(fixForAboveRange, false, 'Above-range retry: falls back to range logic (fix B)');

  console.log('✔ Retry with price movement: in-range uses zap direction, out-of-range uses range logic');
}

console.log('\nAll postZapFixAmountA direction tests passed ✅');
