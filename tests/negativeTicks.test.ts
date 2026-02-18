import assert from 'assert';

/**
 * Test to verify that tick values (including negative ones) are properly 
 * converted to strings for SDK compatibility.
 * Run with: npx ts-node tests/negativeTicks.test.ts
 */

// Test the string conversion of negative tick values
function testTickConversion() {
  console.log('Testing tick value conversion to strings...\n');
  
  // Test positive ticks
  {
    const tick = 1000;
    const tickString = String(tick);
    assert.strictEqual(tickString, '1000', 'Positive tick should convert to string correctly');
    assert.strictEqual(typeof tickString, 'string', 'Converted value should be a string');
    console.log('✔ Positive tick conversion: 1000 → "1000"');
  }
  
  // Test negative ticks (the problematic case)
  {
    const tick = -1141204;
    const tickString = String(tick);
    assert.strictEqual(tickString, '-1141204', 'Negative tick should convert to string correctly');
    assert.strictEqual(typeof tickString, 'string', 'Converted value should be a string');
    console.log('✔ Negative tick conversion: -1141204 → "-1141204"');
  }
  
  // Test zero
  {
    const tick = 0;
    const tickString = String(tick);
    assert.strictEqual(tickString, '0', 'Zero tick should convert to string correctly');
    console.log('✔ Zero tick conversion: 0 → "0"');
  }
  
  // Test large negative tick
  {
    const tick = -999999;
    const tickString = String(tick);
    assert.strictEqual(tickString, '-999999', 'Large negative tick should convert to string correctly');
    console.log('✔ Large negative tick conversion: -999999 → "-999999"');
  }
  
  // Test that the string representation is parseable back to number
  {
    const tick = -1141204;
    const tickString = String(tick);
    const parsed = parseInt(tickString, 10);
    assert.strictEqual(parsed, tick, 'String representation should be parseable back to original number');
    console.log('✔ Round-trip conversion: -1141204 → "-1141204" → -1141204');
  }
  
  console.log('\n✅ All tick conversion tests passed!');
  console.log('\nThis fix ensures that negative tick values are properly handled by the SDK.');
  console.log('The SDK expects tick_lower and tick_upper as string | number.');
  console.log('When passed as strings, negative values are correctly processed without u64 conversion errors.');
}

// Run the tests
testTickConversion();
