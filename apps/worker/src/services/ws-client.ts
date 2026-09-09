import WebSocket from "ws";

export interface WsClientLogger {
  info(context: Record<string, unknown>, msg: string): void;
  error(context: Record<string, unknown>, msg: string): void;
}

export interface WsClientOptions {
  serverBaseUrl: string;
  workerId: string;
  apiKey: string;
  heartbeatIntervalMs: number;
  onData: (data: Record<string, unknown>) => void;
  logger: WsClientLogger;
}

interface WsServerMessage {
  type: "HEARTBEAT_ACK" | "DATA_DISPATCHED" | "ERROR";
  payload?: Record<string, unknown>;
}

interface WsClientMessage {
  type: "HEARTBEAT" | "DATA_RECEIVED" | "DATA_FAILED";
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

  public reportDataReceived(): void {
    this.sendMessage({
      type: "DATA_RECEIVED",
      workerId: this.options.workerId,
    });
  }

  public reportDataFailed(error: string): void {
    this.sendMessage({
      type: "DATA_FAILED",
      workerId: this.options.workerId,
      payload: { error },
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
      { event: "WS_DANG_KET_NOI", url: url.toString() },
      "Dang ket noi den server WebSocket",
    );

    this.ws = new WebSocket(url.toString());

    this.ws.on("open", () => {
      this.logger.info(
        { event: "WS_DA_KET_NOI", workerId: this.options.workerId },
        "Da ket noi vao server qua WebSocket",
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
          { event: "WS_LOI_PARSE_TIN_NHAN", err: error },
          "Khong the phan tich tin nhan tu server",
        );
      }
    });

    this.ws.on("close", (code, reason) => {
      this.logger.info(
        { event: "WS_NGAT_KET_NOI", code, reason: reason.toString() },
        "Ngat ket noi khoi server WebSocket",
      );

      this.stopHeartbeat();

      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (error) => {
      this.logger.error(
        { event: "WS_LOI", err: error },
        "Loi WebSocket",
      );
    });
  }

  private handleServerMessage(message: WsServerMessage): void {
    switch (message.type) {
      case "DATA_DISPATCHED": {
        this.logger.info(
          { event: "WS_DA_NHAN_DU_LIEU" },
          "Da nhan du lieu tu server qua WebSocket",
        );

        this.options.onData(message.payload ?? {});
        break;
      }

      case "HEARTBEAT_ACK": {
        break;
      }

      default:
        this.logger.error(
          { event: "WS_LOAI_TIN_NHAN_KHONG_XAC_DINH", type: message.type },
          "Loai tin nhan khong xac dinh tu server",
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
    this.sendMessage({
      type: "HEARTBEAT",
      workerId: this.options.workerId,
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
