# Cetus Liquidity Rebalance Bot

A minimal automatic liquidity rebalancing bot for [Cetus CLMM](https://app.cetus.zone/) on the Sui Network.

The bot runs a simple loop every 60 seconds:

1. Fetch the position with the highest liquidity in the configured pool.
2. Check if the current pool tick is inside `[tickLower, tickUpper]`.
3. If **in range** → do nothing.
4. If **out of range** → remove liquidity, swap tokens to the correct ratio, open a new position centred on the current tick.

## Prerequisites

- Node.js ≥ 18
- A Sui wallet with funds (SUI for gas + pool tokens for liquidity)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set PRIVATE_KEY and POOL_ADDRESS at minimum

# 3. Build
npm run build

# 4. Run
npm start
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PRIVATE_KEY` | ✅ | — | 64-char hex Ed25519 private key |
| `POOL_ADDRESS` | ✅ | — | Cetus CLMM pool address (`0x…`) |
| `NETWORK` | | `mainnet` | `mainnet` or `testnet` |
| `SUI_RPC_URL` | | public endpoint | Custom Sui RPC URL |
| `CHECK_INTERVAL` | | `60` | Seconds between checks |
| `LOWER_TICK` | | auto | Lower tick for new position |
| `UPPER_TICK` | | auto | Upper tick for new position |
| `TOKEN_A_AMOUNT` | | — | Zap-in amount for token A (base units) |
| `TOKEN_B_AMOUNT` | | — | Zap-in amount for token B (base units) |
| `MAX_SLIPPAGE` | | `0.01` | Max slippage (1%) |
| `GAS_BUDGET` | | `50000000` | Gas budget in MIST |
| `LOG_LEVEL` | | `info` | `debug` \| `info` \| `warn` \| `error` |
| `DRY_RUN` | | `false` | Simulate without executing |

When `LOWER_TICK` / `UPPER_TICK` are not set, the bot preserves the old position's tick-range width, centred on the current tick.

## Project Structure

```
src/
  index.ts              Main loop (60s interval)
  config/
    index.ts            Environment variable loading
    sdkConfig.ts        Cetus SDK on-chain addresses
  services/
    sdk.ts              Wallet + RPC + SDK initialization
    monitor.ts          Pool info & position fetching
    rebalance.ts        Rebalance logic (remove → swap → add)
  utils/
    logger.ts           Timestamped console logger
    retry.ts            Exponential-backoff retry helper
.env.example            Configuration template
```

## Security

- **Never commit your `.env` file** — it contains your private key.
- Use a dedicated bot wallet with only the tokens needed.
- Always test with `DRY_RUN=true` first.

## License

MIT
