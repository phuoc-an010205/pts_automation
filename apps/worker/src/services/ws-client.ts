import WebSocket from "ws";

import type { WorkerJobRequest } from "../domain/job.js";
import type { WorkerRuntimeStatus } from "../domain/job.js";
import type { PhotoshopStatus } from "../controllers/photoshop-controller.js";

export interface WsClientLogger {
  info(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface WsClientOptions {
  serverBaseUrl: string;
  workerId: string;
  apiKey: string;
  heartbeatIntervalMs: number;
  onJob: (job: WorkerJobRequest) => void;
  getStatus: () => {
    status: WorkerRuntimeStatus;
    photoshopStatus: PhotoshopStatus;
    currentJobId: string | null;
  };
  logger: WsClientLogger;
}

interface WsServerMessage {
  type: "JOB_DISPATCHED" | "HEARTBEAT_ACK" | "ERROR";
  payload?: Record<string, unknown>;
}

interface WsClientMessage {
  type: "HEARTBEAT" | "JOB_COMPLETED" | "JOB_FAILED";
  workerId: string;
  payload?: Record<string, unknown>;
}

export class WsClient {
  private readonly options: WsClientOptions;
  private readonly logger: WsClientLogger;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;

  public constructor(options: WsClientOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  public start(): void {
    this.connect();
  }

  public stop(): void {
    this.isShuttingDown = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, "Worker shutting down");
      this.ws = null;
    }
  }

  public reportJobCompleted(jobId: string): void {
    this.sendMessage({
      type: "JOB_COMPLETED",
      workerId: this.options.workerId,
      payload: { jobId },
    });
  }

  public reportJobFailed(jobId: string, error: string): void {
    this.sendMessage({
      type: "JOB_FAILED",
      workerId: this.options.workerId,
      payload: { jobId, error },
    });
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (this.isShuttingDown) {
      return;
    }

    const wsUrl = this.options.serverBaseUrl.replace(/^http/, "ws");
    const url = new URL(wsUrl);
    url.pathname = "/ws/worker";
    url.searchParams.set("workerId", this.options.workerId);
    url.searchParams.set("apiKey", this.options.apiKey);

    this.logger.info(
      { event: "WS_CONNECTING", url: url.toString() },
      "Connecting to server WebSocket",
    );

    this.ws = new WebSocket(url.toString());

    this.ws.on("open", () => {
      this.logger.info(
        { event: "WS_CONNECTED", workerId: this.options.workerId },
        "Connected to server via WebSocket",
      );

      this.startHeartbeat();
      this.sendHeartbeat();
    });

    this.ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as WsServerMessage;
        this.handleServerMessage(message);
      } catch (error) {
        this.logger.error(
          { event: "WS_MESSAGE_PARSE_ERROR", err: error },
          "Failed to parse server message",
        );
      }
    });

    this.ws.on("close", (code, reason) => {
      this.logger.info(
        { event: "WS_DISCONNECTED", code, reason: reason.toString() },
        "Disconnected from server WebSocket",
      );

      this.stopHeartbeat();

      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (error) => {
      this.logger.error(
        { event: "WS_ERROR", err: error },
        "WebSocket error",
      );
    });
  }

  private handleServerMessage(message: WsServerMessage): void {
    switch (message.type) {
      case "JOB_DISPATCHED": {
        const jobId = message.payload?.jobId as string;
        const createdAt = message.payload?.createdAt as string;
        const request = message.payload?.request as WorkerJobRequest["request"];

        this.logger.info(
          { event: "WS_JOB_RECEIVED", jobId },
          "Received job via WebSocket",
        );

        this.options.onJob({
          jobId,
          createdAt,
          request,
        });
        break;
      }

      case "HEARTBEAT_ACK": {
        break;
      }

      default:
        this.logger.error(
          { event: "WS_UNKNOWN_MESSAGE", type: message.type },
          "Unknown message type from server",
        );
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.options.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    const state = this.options.getStatus();
    this.sendMessage({
      type: "HEARTBEAT",
      workerId: this.options.workerId,
      payload: {
        status: state.status,
        photoshopStatus: state.photoshopStatus,
        currentJobId: state.currentJobId,
      },
    });
  }

  private sendMessage(message: WsClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isShuttingDown) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3_000);
  }
}
