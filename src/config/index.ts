import * as dotenv from 'dotenv';

dotenv.config();

export interface BotConfig {
  // Network configuration
  network: 'mainnet' | 'testnet';
  suiRpcUrl?: string;
  privateKey: string;

  // Bot settings
  checkInterval: number; // seconds
  rebalanceThreshold: number; // percentage as decimal (e.g., 0.05 = 5%)

  // Pool settings
  poolAddress: string;
  lowerTick?: number;
  upperTick?: number;
  rangeWidth?: number;

  // Token amounts
  tokenAAmount?: string;
  tokenBAmount?: string;

  // Risk management
  maxSlippage: number;
  gasBudget: number;

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  verboseLogs: boolean;
}

function getEnvVar(key: string, required: boolean = true): string {
  const value = process.env[key];
  if (required && !value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || '';
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseFloat(value) : defaultValue;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  return value ? value.toLowerCase() === 'true' : defaultValue;
}

export function loadConfig(): BotConfig {
  const network = getEnvVar('NETWORK', false) || 'mainnet';
  
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error(`Invalid NETWORK value: ${network}. Must be 'mainnet' or 'testnet'`);
  }

  const privateKey = getEnvVar('PRIVATE_KEY');
  const poolAddress = getEnvVar('POOL_ADDRESS');

  return {
    network,
    suiRpcUrl: getEnvVar('SUI_RPC_URL', false) || undefined,
    privateKey,
    checkInterval: getEnvNumber('CHECK_INTERVAL', 300),
    rebalanceThreshold: getEnvNumber('REBALANCE_THRESHOLD', 0.05),
    poolAddress,
    lowerTick: getEnvVar('LOWER_TICK', false) ? parseInt(getEnvVar('LOWER_TICK', false)) : undefined,
    upperTick: getEnvVar('UPPER_TICK', false) ? parseInt(getEnvVar('UPPER_TICK', false)) : undefined,
    rangeWidth: getEnvVar('RANGE_WIDTH', false) ? parseInt(getEnvVar('RANGE_WIDTH', false)) : undefined,
    tokenAAmount: getEnvVar('TOKEN_A_AMOUNT', false) || undefined,
    tokenBAmount: getEnvVar('TOKEN_B_AMOUNT', false) || undefined,
    maxSlippage: getEnvNumber('MAX_SLIPPAGE', 0.01),
    gasBudget: getEnvNumber('GAS_BUDGET', 50000000),
    logLevel: (getEnvVar('LOG_LEVEL', false) || 'info') as 'debug' | 'info' | 'warn' | 'error',
    verboseLogs: getEnvBoolean('VERBOSE_LOGS', false),
  };
}

export const config = loadConfig();
