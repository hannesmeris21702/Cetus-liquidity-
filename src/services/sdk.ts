import { SuiClient } from '@mysten/sui.js/client';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { CetusClmmSDK } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { BotConfig } from '../config';
import { getSDKConfig } from '../config/sdkConfig';
import { logger } from '../utils/logger';

/**
 * Service for managing Cetus SDK and Sui client initialization.
 */
export class CetusSDKService {
  private sdk: CetusClmmSDK;
  private suiClient: SuiClient;
  private keypair: Ed25519Keypair;
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
    
    // Validate configuration before initializing
    this.validateConfig(config);
    
    this.keypair = this.initializeKeypair(config.privateKey);
    this.suiClient = this.initializeSuiClient(config);
    this.sdk = this.initializeSDK(config);
  }

  private validateConfig(config: BotConfig): void {
    if (!config.privateKey || config.privateKey.trim() === '') {
      throw new Error('PRIVATE_KEY is required but not set in .env file');
    }

    if (!config.poolAddress || config.poolAddress.trim() === '') {
      throw new Error('POOL_ADDRESS is required but not set in .env file');
    }

    // Validate private key format (should be 64 hex characters or 66 with 0x prefix)
    const cleanKey = config.privateKey.startsWith('0x') 
      ? config.privateKey.slice(2) 
      : config.privateKey;
    
    if (!/^[0-9a-fA-F]{64}$/.test(cleanKey)) {
      throw new Error('PRIVATE_KEY must be exactly 64 hexadecimal characters (or 66 with 0x prefix)');
    }

    // Validate pool address format (should be a valid Sui address)
    if (!config.poolAddress.startsWith('0x')) {
      throw new Error('POOL_ADDRESS must start with 0x');
    }
  }

  private initializeKeypair(privateKey: string): Ed25519Keypair {
    try {
      // Remove '0x' prefix if present
      const cleanKey = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
      
      // Convert hex string to Uint8Array
      const privateKeyBytes = new Uint8Array(
        cleanKey.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
      );
      
      return Ed25519Keypair.fromSecretKey(privateKeyBytes);
    } catch (error) {
      logger.error('Failed to initialize keypair', error);
      throw new Error('Invalid private key format');
    }
  }

  private initializeSuiClient(config: BotConfig): SuiClient {
    const rpcUrl = config.suiRpcUrl || this.getDefaultRpcUrl(config.network);
    logger.info(`Initializing Sui client with RPC: ${rpcUrl}`);
    return new SuiClient({ url: rpcUrl });
  }

  private getDefaultRpcUrl(network: 'mainnet' | 'testnet'): string {
    return network === 'mainnet'
      ? 'https://fullnode.mainnet.sui.io:443'
      : 'https://fullnode.testnet.sui.io:443';
  }

  /**
   * Initialize Cetus SDK with proper configuration.
   * Uses network-specific configuration for mainnet or testnet.
   */
  private initializeSDK(config: BotConfig): CetusClmmSDK {
    try {
      logger.info(`Initializing Cetus SDK for ${config.network}`);
      
      const address = this.keypair.getPublicKey().toSuiAddress();
      const rpcUrl = config.suiRpcUrl || this.getDefaultRpcUrl(config.network);
      
      // Get network-specific SDK configuration
      const sdkConfig = getSDKConfig(config.network);
      
      // Override RPC URL and simulation account with user's settings
      const sdkOptions = {
        ...sdkConfig,
        fullRpcUrl: rpcUrl,
        simulationAccount: {
          address,
        },
      };
      
      // Initialize the SDK
      const sdk = new CetusClmmSDK(sdkOptions);
      
      // Set the sender address for transaction signing
      sdk.senderAddress = address;
      
      logger.info(`Cetus SDK initialized successfully`, {
        network: config.network,
        address,
        rpcUrl,
      });
      
      return sdk;
    } catch (error) {
      logger.error('Failed to initialize Cetus SDK', error);
      throw error;
    }
  }

  getSdk(): CetusClmmSDK {
    return this.sdk;
  }

  getSuiClient(): SuiClient {
    return this.suiClient;
  }

  getKeypair(): Ed25519Keypair {
    return this.keypair;
  }

  getAddress(): string {
    return this.keypair.getPublicKey().toSuiAddress();
  }

  async getBalance(coinType: string): Promise<string> {
    try {
      const address = this.getAddress();
      const balance = await this.suiClient.getBalance({
        owner: address,
        coinType,
      });
      return balance.totalBalance;
    } catch (error) {
      logger.error(`Failed to get balance for ${coinType}`, error);
      throw error;
    }
  }
}
