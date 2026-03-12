import { CetusSDKService } from './services/sdk';
import { PositionMonitorService } from './services/monitor';
import { RebalanceService } from './services/rebalance';
import { config } from './config';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  logger.info('=== Cetus Liquidity Rebalance Bot ===');

  // 1. Wallet initialization (Ed25519 keypair from PRIVATE_KEY env var)
  // 2. Connection to Sui RPC
  // 3. Cetus CLMM SDK initialization
  const sdkService = new CetusSDKService(config);
  const monitorService = new PositionMonitorService(sdkService, config);
  const rebalanceService = new RebalanceService(sdkService, monitorService, config);

  logger.info('Bot initialized', {
    network: config.network,
    address: sdkService.getAddress(),
    poolAddress: config.poolAddress,
    checkInterval: config.checkInterval,
    dryRun: process.env.DRY_RUN === 'true',
  });

  // Graceful shutdown
  process.on('SIGINT', () => { logger.info('Shutting down...'); process.exit(0); });
  process.on('SIGTERM', () => { logger.info('Shutting down...'); process.exit(0); });

  // 7. Run in a simple loop every 60 seconds
  while (true) {
    try {
      logger.info('=== Checking position ===');

      // Steps 4-6: fetch position, check range, rebalance if needed
      const result = await rebalanceService.checkAndRebalance(config.poolAddress);

      if (result) {
        if (result.success) {
          logger.info('Rebalance completed', {
            transactionDigest: result.transactionDigest,
            oldPosition: result.oldPosition,
            newPosition: result.newPosition,
          });
        } else {
          logger.warn('Rebalance attempted but did not complete', { error: result.error });
        }
      } else {
        logger.info('Position is in range — no action needed');
      }
    } catch (error) {
      logger.error('Error during position check', error);
    }

    logger.info(`Sleeping ${config.checkInterval}s until next check...`);
    await new Promise(resolve => setTimeout(resolve, config.checkInterval * 1000));
  }
}

main().catch(error => {
  logger.error('Fatal error', error);
  process.exit(1);
});
