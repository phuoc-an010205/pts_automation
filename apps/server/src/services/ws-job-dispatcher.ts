import type { WebSocket } from "ws";

export interface WsJobDispatcherLogger {
  info(context: Record<string, unknown>, msg: string): void;
  error(context: Record<string, unknown>, msg: string): void;
}

interface ConnectedWorker {
  workerId: string;
  ws: WebSocket;
  status: "QUEUED" | "RUNNING" | "ERROR";
  lastDataSentAt: string | null;
  lastDataReceivedAt: string | null;
}

export interface WsWorkerMessage {
  type: "HEARTBEAT" | "DATA_RECEIVED" | "DATA_FAILED";
  workerId: string;
  payload?: Record<string, unknown>;
}

export interface WsServerMessage {
  type: "HEARTBEAT_ACK" | "DATA_DISPATCHED" | "ERROR";
  payload?: Record<string, unknown>;
}

export class WsJobDispatcher {
  private readonly logger: WsJobDispatcherLogger;
  private readonly workers = new Map<string, ConnectedWorker>();

  public constructor(logger: WsJobDispatcherLogger) {
    this.logger = logger;
  }

  public handleConnection(ws: WebSocket, workerId: string): void {
    const existing = this.workers.get(workerId);
    if (existing) {
      this.logger.info(
        { event: "WS_TAI_KET_NOI", workerId },
        "Worker ket noi lai, dong ket noi cu",
      );
      existing.ws.close(1000, "Reconnected");
    }

    const worker: ConnectedWorker = {
      workerId,
      ws,
      status: "QUEUED",
      lastDataSentAt: null,
      lastDataReceivedAt: null,
    };

    this.workers.set(workerId, worker);

    this.logger.info(
      { event: "WS_WORKER_KET_NOI", workerId },
      "Worker da ket noi vao WebSocket",
    );

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as WsWorkerMessage;
        this.handleWorkerMessage(worker, message);
      } catch (error) {
        this.logger.error(
          { event: "WS_LOI_PARSE_TIN_NHAN", workerId, err: error },
          "Khong the phan tich tin nhan tu worker",
        );
      }
    });

    ws.on("close", () => {
      this.workers.delete(workerId);
      this.logger.info(
        { event: "WS_WORKER_NGAT_KET_NOI", workerId },
        "Worker ngat ket noi WebSocket",
      );
    });

    ws.on("error", (error) => {
      this.logger.error(
        { event: "WS_LOI_WORKER", workerId, err: error },
        "Loi WebSocket tu worker",
      );
    });
  }

  public sendDataToWorker(
    workerId: string,
    data: Record<string, unknown>,
  ): boolean {
    const worker = this.workers.get(workerId);
    if (!worker || worker.ws.readyState !== 1) {
      return false;
    }

    worker.status = "RUNNING";
    worker.lastDataSentAt = new Date().toISOString();

    this.sendToWorker(worker, {
      type: "DATA_DISPATCHED",
      payload: data,
    });

    this.logger.info(
      { event: "WS_DA_GUI_DU_LIEU", workerId },
      "Da gui du lieu den worker qua WebSocket",
    );

    return true;
  }

  public getConnectedWorkers(): Array<{
    workerId: string;
    status: string;
    lastDataSentAt: string | null;
    lastDataReceivedAt: string | null;
  }> {
    return Array.from(this.workers.values()).map((w) => ({
      workerId: w.workerId,
      status: w.status,
      lastDataSentAt: w.lastDataSentAt,
      lastDataReceivedAt: w.lastDataReceivedAt,
    }));
  }

  public isWorkerConnected(workerId: string): boolean {
    return this.workers.has(workerId);
  }

  private handleWorkerMessage(
    worker: ConnectedWorker,
    message: WsWorkerMessage,
  ): void {
    switch (message.type) {
      case "HEARTBEAT": {
        this.sendToWorker(worker, {
          type: "HEARTBEAT_ACK",
          payload: { timestamp: new Date().toISOString() },
        });
        break;
      }

      case "DATA_RECEIVED": {
        worker.lastDataReceivedAt = new Date().toISOString();

        this.logger.info(
          { event: "WS_WORKER_NHAN_DU_LIEU", workerId: worker.workerId },
          "Worker da nhan du lieu qua WebSocket",
        );
        break;
      }

      case "DATA_FAILED": {
        worker.status = "ERROR";
        const errorMsg = message.payload?.error as string;

        this.logger.error(
          { event: "WS_WORKER_LOI_XU_LY", workerId: worker.workerId, error: errorMsg },
          "Worker xu ly du lieu that bai",
        );
        break;
      }

      default:
        this.logger.error(
          { event: "WS_LOAI_TIN_NHAN_KHONG_XAC_DINH", type: message.type },
          "Loai tin nhan khong xac dinh tu worker",
        );
    }
  }

  private sendToWorker(worker: ConnectedWorker, message: WsServerMessage): void {
    if (worker.ws.readyState !== 1) {
      return;
    }

    worker.ws.send(JSON.stringify(message));
  }
}
