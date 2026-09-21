import { PluginBridge } from "./plugin-bridge.js";
import type { LoggerLike } from "./logger.js";
import { consoleLogger } from "./logger.js";

export interface HealthCheckConfig {
  pingInterval: number;
  pongTimeout: number;
  maxMissedPongs: number;
}

const DEFAULT_CONFIG: HealthCheckConfig = {
  pingInterval: 5000,
  pongTimeout: 2000,
  maxMissedPongs: 3,
};

export class PluginHealthCheck {
  private bridge: PluginBridge;
  private config: HealthCheckConfig;
  private onUnhealthy: () => void;
  private logger: LoggerLike;

  private missedPongCount = 0;
  private isRunning = false;

  constructor(
    bridge: PluginBridge,
    options: {
      config?: Partial<HealthCheckConfig>;
      onUnhealthy: () => void;
      logger?: LoggerLike;
    },
  ) {
    this.bridge = bridge;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.onUnhealthy = options.onUnhealthy;
    this.logger = options.logger ?? consoleLogger;
  }

  start(): void {
    if (this.isRunning) {
      this.logger.warn("[HealthCheck] Already running");
      return;
    }

    this.isRunning = true;
    this.missedPongCount = 0;
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    this.missedPongCount = 0;
    this.logger.log("[HealthCheck] Stopped monitoring");
  }

  isHealthCheckRunning(): boolean {
    return this.isRunning;
  }

  getMissedPongCount(): number {
    return this.missedPongCount;
  }
}
