import { CetusSDKService } from './services/sdk';
import { PositionMonitorService } from './services/monitor';
import { RebalanceService } from './services/rebalance';
import { config } from './config';
import { logger } from './utils/logger';

export class CetusRebalanceBot {
  private sdkService: CetusSDKService;
  private monitorService: PositionMonitorService;
  private rebalanceService: RebalanceService;
  private isRunning: boolean = false;
  private intervalId?: NodeJS.Timeout;

  constructor() {
    logger.info('Initializing Cetus Rebalance Bot...');
    
    // Initialize services
    this.sdkService = new CetusSDKService(config);
    this.monitorService = new PositionMonitorService(this.sdkService, config);
    this.rebalanceService = new RebalanceService(
      this.sdkService,
      this.monitorService,
      config
    );

    logger.info('Bot initialized successfully', {
      network: config.network,
      address: this.sdkService.getAddress(),
      poolAddress: config.poolAddress,
      checkInterval: config.checkInterval,
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Bot is already running');
      return;
    }

    logger.info('Initializing Cetus Rebalance Bot...');

    // Validate environment setup before starting
    await this.validateSetup();

    this.isRunning = true;
    logger.info('Bot started successfully');

    // Perform initial check
    await this.performCheck();

    // Schedule periodic checks
    this.intervalId = setInterval(async () => {
      await this.performCheck();
    }, config.checkInterval * 1000);

    logger.info(`Bot running - checking every ${config.checkInterval} seconds`);
  }

  private async validateSetup(): Promise<void> {
    try {
      logger.info('Validating bot setup...');

      // Check wallet balance
      const address = this.sdkService.getAddress();
      logger.info(`Using wallet address: ${address}`);

      const suiClient = this.sdkService.getSuiClient();
      
      // Get SUI balance
      try {
        const balance = await suiClient.getBalance({
          owner: address,
          coinType: '0x2::sui::SUI',
        });
        const suiBalance = parseFloat(balance.totalBalance) / 1_000_000_000; // Convert MIST to SUI
        logger.info(`Wallet SUI balance: ${suiBalance.toFixed(4)} SUI`);
        
        if (suiBalance < 0.1) {
          logger.warn(`Low SUI balance (${suiBalance.toFixed(4)} SUI). You may not have enough for gas fees.`);
        }
      } catch (error) {
        logger.warn('Could not fetch wallet balance', error);
      }

      // Validate pool exists
      logger.info(`Validating pool address: ${config.poolAddress}`);
      try {
        const poolInfo = await this.monitorService.getPoolInfo(config.poolAddress);
        logger.info('Pool validation successful', {
          poolAddress: poolInfo.poolAddress,
          currentTick: poolInfo.currentTickIndex,
          coinTypeA: poolInfo.coinTypeA,
          coinTypeB: poolInfo.coinTypeB,
        });
      } catch (error) {
        logger.error('Pool validation failed. Cannot start bot.');
        throw new Error('Invalid pool configuration. Please check POOL_ADDRESS in .env file.');
      }

      // Check for existing positions
      try {
        const positions = await this.monitorService.getPositions(address);
        const poolPositions = positions.filter(p => p.poolAddress === config.poolAddress);
        
        if (poolPositions.length > 0) {
          logger.info(`Found ${poolPositions.length} existing position(s) in this pool`);
          poolPositions.forEach((pos, idx) => {
            logger.info(`Position ${idx + 1}:`, {
              id: pos.positionId,
              tickRange: `[${pos.tickLower}, ${pos.tickUpper}]`,
              inRange: pos.inRange,
            });
          });
        } else {
          logger.info('No existing positions found in this pool');
          logger.warn('The bot will attempt to create a new position when rebalancing is triggered');
        }
      } catch (error) {
        logger.warn('Could not fetch existing positions', error);
      }

      logger.info('Setup validation completed successfully');
    } catch (error) {
      logger.error('Setup validation failed', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Bot is not running');
      return;
    }

    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    logger.info('Bot stopped');
  }

  private async performCheck(): Promise<void> {
    try {
      logger.info('=== Performing position check ===');

      const result = await this.rebalanceService.checkAndRebalance(config.poolAddress);

      if (result) {
        logger.info('Rebalance executed', {
          success: result.success,
          transactionDigest: result.transactionDigest,
          oldPosition: result.oldPosition,
          newPosition: result.newPosition,
        });
      } else {
        logger.info('No rebalance needed');
      }
    } catch (error) {
      logger.error('Error during position check', error);
    }
  }

  async getStatus(): Promise<{
    running: boolean;
    address: string;
    network: string;
    poolAddress: string;
  }> {
    return {
      running: this.isRunning,
      address: this.sdkService.getAddress(),
      network: config.network,
      poolAddress: config.poolAddress,
    };
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal - shutting down...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal - shutting down...');
  process.exit(0);
});
