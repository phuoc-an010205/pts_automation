import type { WebSocket } from "ws";

import type { RuntimeJob } from "../domain/job.js";

export interface WsJobDispatcherLogger {
  info(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

interface ConnectedWorker {
  workerId: string;
  ws: WebSocket;
  status: "IDLE" | "BUSY" | "ERROR";
  currentJobId: string | null;
}

export interface WsWorkerMessage {
  type: "REGISTER" | "HEARTBEAT" | "JOB_COMPLETED" | "JOB_FAILED";
  workerId: string;
  payload?: Record<string, unknown>;
}

export interface WsServerMessage {
  type: "JOB_DISPATCHED" | "HEARTBEAT_ACK" | "ERROR";
  payload?: Record<string, unknown>;
}

export class WsJobDispatcher {
  private readonly logger: WsJobDispatcherLogger;
  private readonly workers = new Map<string, ConnectedWorker>();
  private readonly pendingJobs: RuntimeJob[] = [];

  public constructor(logger: WsJobDispatcherLogger) {
    this.logger = logger;
  }

  public handleConnection(ws: WebSocket, workerId: string): void {
    const existing = this.workers.get(workerId);
    if (existing) {
      this.logger.info(
        { event: "WS_RECONNECT", workerId },
        "Worker reconnected, closing old connection",
      );
      existing.ws.close(1000, "Reconnected");
    }

    const worker: ConnectedWorker = {
      workerId,
      ws,
      status: "IDLE",
      currentJobId: null,
    };

    this.workers.set(workerId, worker);

    this.logger.info(
      { event: "WS_WORKER_CONNECTED", workerId },
      "Worker connected via WebSocket",
    );

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as WsWorkerMessage;
        this.handleWorkerMessage(worker, message);
      } catch (error) {
        this.logger.error(
          { event: "WS_MESSAGE_PARSE_ERROR", workerId, err: error },
          "Failed to parse worker message",
        );
      }
    });

    ws.on("close", () => {
      this.workers.delete(workerId);
      this.logger.info(
        { event: "WS_WORKER_DISCONNECTED", workerId },
        "Worker disconnected from WebSocket",
      );
    });

    ws.on("error", (error) => {
      this.logger.error(
        { event: "WS_WORKER_ERROR", workerId, err: error },
        "Worker WebSocket error",
      );
    });

    this.dispatchPendingJobs();
  }

  public notifyJobCreated(job: RuntimeJob): void {
    this.pendingJobs.push(job);
    this.dispatchPendingJobs();
  }

  public getConnectedWorkers(): Array<{
    workerId: string;
    status: string;
    currentJobId: string | null;
  }> {
    return Array.from(this.workers.values()).map((w) => ({
      workerId: w.workerId,
      status: w.status,
      currentJobId: w.currentJobId,
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
        worker.status = (message.payload?.status as ConnectedWorker["status"]) ?? "IDLE";
        worker.currentJobId = (message.payload?.currentJobId as string) ?? null;

        this.sendToWorker(worker, {
          type: "HEARTBEAT_ACK",
          payload: { timestamp: new Date().toISOString() },
        });

        this.dispatchPendingJobs();
        break;
      }

      case "JOB_COMPLETED": {
        const jobId = message.payload?.jobId as string;
        worker.status = "IDLE";
        worker.currentJobId = null;

        this.logger.info(
          { event: "WS_JOB_COMPLETED", workerId: worker.workerId, jobId },
          "Worker reported job completion via WebSocket",
        );

        this.dispatchPendingJobs();
        break;
      }

      case "JOB_FAILED": {
        const jobId = message.payload?.jobId as string;
        worker.status = "IDLE";
        worker.currentJobId = null;

        this.logger.info(
          { event: "WS_JOB_FAILED", workerId: worker.workerId, jobId },
          "Worker reported job failure via WebSocket",
        );

        this.dispatchPendingJobs();
        break;
      }

      default:
        this.logger.error(
          { event: "WS_UNKNOWN_MESSAGE_TYPE", type: message.type },
          "Unknown message type from worker",
        );
    }
  }

  private dispatchPendingJobs(): void {
    const idleWorker = Array.from(this.workers.values()).find(
      (w) => w.status === "IDLE" && w.ws.readyState === 1,
    );

    if (!idleWorker || this.pendingJobs.length === 0) {
      return;
    }

    const job = this.pendingJobs.shift();
    if (!job) {
      return;
    }

    idleWorker.status = "BUSY";
    idleWorker.currentJobId = job.id;

    this.sendToWorker(idleWorker, {
      type: "JOB_DISPATCHED",
      payload: {
        jobId: job.id,
        createdAt: job.createdAt,
        request: job.request,
      },
    });

    this.logger.info(
      {
        event: "WS_JOB_DISPATCHED",
        jobId: job.id,
        workerId: idleWorker.workerId,
      },
      "Job dispatched to worker via WebSocket",
    );

    this.dispatchPendingJobs();
  }

  private sendToWorker(worker: ConnectedWorker, message: WsServerMessage): void {
    if (worker.ws.readyState !== 1) {
      return;
    }

    worker.ws.send(JSON.stringify(message));
  }
}
