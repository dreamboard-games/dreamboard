import type {
  HostToPluginPayload,
  InteractionResult,
  PluginGameplayFrame,
  PluginSessionDescriptor,
  PluginToHostPayload,
} from "@dreamboard-games/sdk/plugin-runtime-contract";
import {
  DREAMBOARD_PLUGIN_PROTOCOL,
  DREAMBOARD_PLUGIN_PROTOCOL_VERSION,
  HostToPluginEnvelopeSchema,
  PluginToHostEnvelopeSchema,
  HostToPluginPayloadSchema,
} from "@dreamboard-games/sdk/plugin-runtime-contract";
import type { LoggerLike } from "./logger.js";
import { consoleLogger } from "./logger.js";

type MessageHandler<T> = (data: T) => void;

export interface PluginBridgeOptions {
  logger?: LoggerLike;
}

export class PluginBridge {
  private iframe: HTMLIFrameElement;
  private targetOrigin: string;
  private expectedOrigin: string;
  private handlers: Map<
    PluginToHostPayload["type"],
    Set<MessageHandler<PluginToHostPayload>>
  > = new Map();
  private messageListener: ((event: MessageEvent) => void) | null = null;
  private logger: LoggerLike;
  private activeChannelId: string | null;
  private outboundSequence = 0;

  constructor(
    iframe: HTMLIFrameElement,
    targetOrigin = "*",
    options: PluginBridgeOptions = {},
  ) {
    if (!iframe.contentWindow) {
      throw new Error("iframe.contentWindow is not available");
    }

    this.iframe = iframe;
    const originPolicy = resolveIframeOriginPolicy(iframe, targetOrigin);
    this.expectedOrigin = originPolicy.expectedOrigin;
    this.targetOrigin = originPolicy.targetOrigin;
    this.logger = options.logger ?? consoleLogger;
    this.activeChannelId = generateChannelId();
    this.setupMessageListener();
  }

  private validateOrigin(origin: string): boolean {
    return origin === this.expectedOrigin;
  }

  private setupMessageListener(): void {
    this.messageListener = (event: MessageEvent) => {
      if (event.source !== this.iframe.contentWindow) {
        return;
      }
      if (!this.validateOrigin(event.origin)) {
        return;
      }

      const result = PluginToHostEnvelopeSchema.safeParse(event.data);
      if (!result.success) {
        return;
      }
      if (
        this.activeChannelId === null ||
        result.data.channelId !== this.activeChannelId
      ) {
        return;
      }

      this.emit(result.data.payload.type, result.data.payload);
    };

    window.addEventListener("message", this.messageListener);
  }

  sendInit(session: PluginSessionDescriptor): number | null {
    return this.sendToPlugin({
      type: "runtime.init",
      session,
    });
  }

  sendGameplayFrame(frame: PluginGameplayFrame): number | null {
    return this.sendToPlugin({
      type: "gameplay.frame",
      frame,
    });
  }

  sendSubmitResult(result: InteractionResult): number | null {
    return this.sendToPlugin(result);
  }

  send(message: HostToPluginPayload): number | null {
    return this.sendToPlugin(message);
  }

  private sendToPlugin(message: HostToPluginPayload): number | null {
    const messageType =
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      typeof message.type === "string"
        ? message.type
        : "unknown";
    if (!this.iframe.contentWindow) {
      this.logger.error(
        "[PluginBridge] iframe contentWindow not available for message:",
        messageType,
      );
      return null;
    }

    const result = HostToPluginPayloadSchema.safeParse(message);
    if (!result.success) {
      this.logger.error(
        "[PluginBridge] Failed to validate outgoing message:",
        message,
      );
      return null;
    }

    if (this.activeChannelId === null) {
      this.logger.error(
        "[PluginBridge] Cannot send message on an inactive channel:",
        result.data.type,
      );
      return null;
    }

    const sequence = ++this.outboundSequence;
    const envelope = {
      protocol: DREAMBOARD_PLUGIN_PROTOCOL,
      version: DREAMBOARD_PLUGIN_PROTOCOL_VERSION,
      channelId: this.activeChannelId,
      sequence,
      payload: result.data,
    };
    const envelopeResult = HostToPluginEnvelopeSchema.safeParse(envelope);
    if (!envelopeResult.success) {
      this.logger.error(
        "[PluginBridge] Failed to validate outgoing envelope:",
        messageType,
      );
      return null;
    }

    this.iframe.contentWindow.postMessage(
      envelopeResult.data,
      this.targetOrigin,
    );
    return sequence;
  }

  onPluginMessage<T extends PluginToHostPayload["type"]>(
    type: T,
    handler: MessageHandler<Extract<PluginToHostPayload, { type: T }>>,
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }

    const handlers = this.handlers.get(type);
    if (!handlers) {
      throw new Error(`Handler for type ${type} not found`);
    }

    handlers.add(handler as MessageHandler<PluginToHostPayload>);

    return () => {
      handlers.delete(handler as MessageHandler<PluginToHostPayload>);
    };
  }

  private emit(
    type: PluginToHostPayload["type"],
    data: PluginToHostPayload,
  ): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      handlers.forEach((handler) => handler(data));
    }
  }

  disconnect(): void {
    if (this.messageListener) {
      window.removeEventListener("message", this.messageListener);
      this.messageListener = null;
    }

    this.handlers.clear();
    this.activeChannelId = null;
  }
}

interface IframeOriginPolicy {
  expectedOrigin: string;
  targetOrigin: string;
}

function resolveIframeOriginPolicy(
  iframe: HTMLIFrameElement,
  requestedTargetOrigin: string,
): IframeOriginPolicy {
  if (requestedTargetOrigin !== "*" && requestedTargetOrigin !== "null") {
    return {
      expectedOrigin: requestedTargetOrigin,
      targetOrigin: requestedTargetOrigin,
    };
  }

  if (requestedTargetOrigin === "null" || hasOpaqueSandboxOrigin(iframe)) {
    return {
      expectedOrigin: "null",
      targetOrigin: "*",
    };
  }

  try {
    const iframeUrl = new URL(iframe.src, window.location.href);
    if (iframeUrl.origin && iframeUrl.origin !== "null") {
      return {
        expectedOrigin: iframeUrl.origin,
        targetOrigin: iframeUrl.origin,
      };
    }
  } catch {
    // Fall through to the opaque-origin fallback.
  }

  return {
    expectedOrigin: "null",
    targetOrigin: "*",
  };
}

function hasOpaqueSandboxOrigin(iframe: HTMLIFrameElement): boolean {
  const sandbox = iframe.sandbox;
  if (!sandbox || sandbox.length === 0) {
    return false;
  }
  return !sandbox.contains("allow-same-origin");
}

function generateChannelId(): string {
  if (globalThis.crypto && "randomUUID" in globalThis.crypto) {
    return globalThis.crypto.randomUUID();
  }

  return Array.from({ length: 4 }, () =>
    Math.random().toString(36).slice(2).padEnd(8, "0"),
  ).join("");
}
