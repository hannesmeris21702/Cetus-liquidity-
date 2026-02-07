# Setup Guide - Cetus Liquidity Rebalance Bot

This guide will help you set up and run the Cetus Liquidity Rebalance Bot successfully.

## Prerequisites

1. **Node.js 18+** installed
2. **A Sui wallet** with:
   - Private key (64 hex characters)
   - Some SUI tokens for gas fees (at least 0.5 SUI recommended)
   - Tokens you want to provide as liquidity
3. **A Cetus Pool** you want to manage (find pools at https://app.cetus.zone/)

## Step-by-Step Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create a `.env` file from the example:

```bash
cp .env.example .env
```

### 3. Set Required Configuration

Edit `.env` and set these **required** values:

#### a. Private Key

```env
PRIVATE_KEY=your_64_character_hex_private_key_here
```

**How to get your private key:**

- **From Sui Wallet**: Export your private key (without 0x prefix)
- **Generate new wallet** (for testing):
  ```bash
  npm install -g @mysten/sui
  sui client new-address ed25519
  ```

⚠️ **IMPORTANT**: 
- Never commit your private key to git
- Keep it secure and private
- Use a test wallet on testnet first

#### b. Pool Address

```env
POOL_ADDRESS=0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0
```

**How to find a pool address:**

1. Go to https://app.cetus.zone/
2. Select a pool you want to manage
3. Copy the pool address from the URL or pool details

#### c. Network

```env
NETWORK=testnet  # Start with testnet!
```

**Networks:**
- `testnet` - For testing (recommended first)
- `mainnet` - For production (use real funds)

### 4. Optional Configuration

```env
# Custom RPC endpoint (if default is slow)
SUI_RPC_URL=https://sui-mainnet.gateway.tatum.io

# Check positions every 5 minutes
CHECK_INTERVAL=300

# Rebalance when price moves 5% from range
REBALANCE_THRESHOLD=0.05

# Specify exact token amounts to use
TOKEN_A_AMOUNT=1000000000  # 1 token with 9 decimals
TOKEN_B_AMOUNT=1000000000

# Enable dry-run mode (no real transactions)
DRY_RUN=true
```

### 5. Build the Bot

```bash
npm run build
```

### 6. Test with Dry Run

**IMPORTANT**: Always test with dry-run first!

```env
DRY_RUN=true
```

Then run:

```bash
npm start
```

You should see:
```
⚠️  DRY RUN MODE ENABLED - No real transactions will be executed
[INFO] Starting Cetus Rebalance Bot...
[INFO] Validating bot setup...
[INFO] Using wallet address: 0x...
[INFO] Wallet SUI balance: X.XXXX SUI
[INFO] Validating pool address: 0x...
[INFO] Pool validation successful
```

### 7. Run in Production

Once dry-run works successfully:

1. Set `DRY_RUN=false` in `.env`
2. Ensure you have sufficient SUI for gas
3. Run the bot:

```bash
npm start
```

## Common Issues and Solutions

### Issue: "Missing required environment variable: PRIVATE_KEY"

**Solution**: Make sure you have a `.env` file with `PRIVATE_KEY` set.

```bash
cp .env.example .env
# Edit .env and add your private key
```

### Issue: "PRIVATE_KEY must be exactly 64 hexadecimal characters"

**Solution**: Your private key should be 64 hex characters (0-9, a-f).

- Remove `0x` prefix if present
- Should look like: `a1b2c3d4e5f6...` (64 characters)
- Not base64 or other encoding

### Issue: "Pool does not exist on mainnet"

**Solutions**:
1. Verify the pool address is correct
2. Check you're on the right network (mainnet vs testnet)
3. Visit https://app.cetus.zone/ to find valid pools
4. Ensure pool address starts with `0x`

### Issue: "Failed to get pool info" / Network errors

**Solutions**:
1. Check your internet connection
2. Try a different RPC endpoint in `SUI_RPC_URL`:
   - `https://fullnode.mainnet.sui.io:443`
   - `https://sui-mainnet.gateway.tatum.io`
   - `https://sui-mainnet-endpoint.blockvision.org/`
3. The default RPC might be rate-limited or slow

### Issue: "Low SUI balance"

**Solution**: Your wallet needs SUI for gas fees.

- **Testnet**: Get free testnet SUI from faucet:
  ```bash
  curl --location --request POST 'https://faucet.testnet.sui.io/gas' \
    --header 'Content-Type: application/json' \
    --data-raw '{ "FixedAmountRequest": { "recipient": "YOUR_ADDRESS" } }'
  ```
- **Mainnet**: Purchase SUI from an exchange and send to your wallet

### Issue: "Insufficient token balance to add liquidity"

**Solution**: You need both tokens in the pair to add liquidity.

1. Check your wallet has both tokens (Token A and Token B)
2. If using specific amounts, set `TOKEN_A_AMOUNT` and `TOKEN_B_AMOUNT` in `.env`
3. Otherwise bot will try to use 10% of your available balance

### Issue: Transaction fails with gas errors

**Solutions**:
1. Increase `GAS_BUDGET` in `.env`:
   ```env
   GAS_BUDGET=200000000  # 0.2 SUI
   ```
2. Ensure wallet has enough SUI

## Testing Checklist

Before running with real funds:

- [ ] Tested with `DRY_RUN=true` successfully
- [ ] Tested on `NETWORK=testnet` first
- [ ] Verified wallet has sufficient SUI for gas
- [ ] Verified wallet has tokens for liquidity
- [ ] Confirmed pool address is correct
- [ ] Reviewed `CHECK_INTERVAL` and `REBALANCE_THRESHOLD` settings
- [ ] Set up proper logging (`LOG_LEVEL=info`)
- [ ] Have a way to monitor the bot (check logs regularly)

## Monitoring Your Bot

### Check Logs

The bot logs important information:

```
[INFO] Pool validation successful
[INFO] Found 1 existing position(s) in this pool
[INFO] Position 1: { id: '0x...', tickRange: [100, 200], inRange: true }
[INFO] Position is optimal - no rebalance needed
```

### Watch for Errors

```
[ERROR] Pool validation failed
[ERROR] Failed to get pool info
[ERROR] Transaction failed
```

If you see errors, check the error message and refer to "Common Issues" above.

### Successful Rebalance

```
[INFO] Position needs rebalancing - executing rebalance
[INFO] Starting rebalance process
[INFO] Removing liquidity
[INFO] Liquidity removed successfully { digest: '0x...' }
[INFO] Opening position...
[INFO] Position opened successfully { digest: '0x...' }
[INFO] Adding liquidity to position...
[INFO] Liquidity added successfully { digest: '0x...' }
[INFO] Rebalance completed successfully
```

## Advanced Configuration

### Multiple Positions

To manage multiple pools, run multiple instances with different `.env` files:

```bash
# Terminal 1
DRY_RUN=false POOL_ADDRESS=0x... npm start

# Terminal 2  
DRY_RUN=false POOL_ADDRESS=0x... npm start
```

### Custom Range Strategy

Edit tick ranges in `.env`:

```env
# Fixed range strategy
LOWER_TICK=-1000
UPPER_TICK=1000

# Or let bot calculate based on range width
RANGE_WIDTH=100
```

### Logging Verbosity

For debugging:

```env
LOG_LEVEL=debug
VERBOSE_LOGS=true
```

## Safety Tips

1. **Always test on testnet first**
2. **Start with small amounts**
3. **Monitor the first few rebalances closely**
4. **Use dry-run mode to test configuration changes**
5. **Keep your private key secure**
6. **Set reasonable gas budgets**
7. **Don't run multiple bots on the same pool/position**
8. **Be aware of gas costs** - frequent rebalancing costs gas

## Getting Help

If you encounter issues:

1. Check this guide's "Common Issues" section
2. Review the logs for error messages
3. Verify your configuration in `.env`
4. Test with `DRY_RUN=true` first
5. Try on testnet before mainnet
6. Check Cetus documentation: https://cetus-1.gitbook.io/

## Next Steps

Once your bot is running successfully:

1. Monitor it regularly
2. Adjust `CHECK_INTERVAL` and `REBALANCE_THRESHOLD` based on your strategy
3. Track your liquidity provision performance
4. Consider setting up alerts for errors
5. Keep the bot running (consider using a process manager like PM2)

---

**Remember**: This bot manages your liquidity positions automatically. Always understand what it's doing before running with real funds!
