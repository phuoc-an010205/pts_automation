import { JobProcessor } from "./job-processor.js";
import { ServerClient, ServerClientError } from "./server-client.js";

export interface WorkerCoordinatorLogger {
  info(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface WorkerCoordinatorOptions {
  workerId: string;
  advertisedUrl: string;
  version: string;
  heartbeatIntervalMs: number;
}

export interface WorkerConnectionSnapshot {
  registered: boolean;
  lastSuccessfulHeartbeatAt: string | null;
  lastError: string | null;
}

export class WorkerCoordinator {
  private readonly serverClient: ServerClient;
  private readonly jobProcessor: JobProcessor;
  private readonly options: WorkerCoordinatorOptions;
  private readonly logger: WorkerCoordinatorLogger;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private activeCycle: Promise<void> | null = null;
  private isStarted = false;
  private registered = false;
  private lastSuccessfulHeartbeatAt: string | null = null;
  private lastError: string | null = null;

  public constructor(
    serverClient: ServerClient,
    jobProcessor: JobProcessor,
    options: WorkerCoordinatorOptions,
    logger: WorkerCoordinatorLogger,
  ) {
    if (
      !Number.isInteger(options.heartbeatIntervalMs) ||
      options.heartbeatIntervalMs < 1_000
    ) {
      throw new Error(
        "heartbeatIntervalMs must be an integer of at least 1000ms",
      );
    }

    this.serverClient = serverClient;
    this.jobProcessor = jobProcessor;
    this.options = options;
    this.logger = logger;
  }

  public async start(): Promise<void> {
    if (this.isStarted) {
      if (this.activeCycle) {
        await this.activeCycle;
      }
      return;
    }

    this.isStarted = true;
    await this.runCycle();
  }

  public async stop(): Promise<void> {
    this.isStarted = false;

    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.activeCycle) {
      await this.activeCycle;
    }
  }

  public getConnectionState(): WorkerConnectionSnapshot {
    return {
      registered: this.registered,
      lastSuccessfulHeartbeatAt: this.lastSuccessfulHeartbeatAt,
      lastError: this.lastError,
    };
  }

  private async runCycle(): Promise<void> {
    if (this.activeCycle) {
      await this.activeCycle;
      return;
    }

    const cycle = this.synchronizeWithServer();
    this.activeCycle = cycle;

    try {
      await cycle;
    } finally {
      this.activeCycle = null;
      this.scheduleNextCycle();
    }
  }

  private async synchronizeWithServer(): Promise<void> {
    try {
      if (!this.registered) {
        await this.serverClient.registerWorker({
          workerId: this.options.workerId,
          advertisedUrl: this.options.advertisedUrl,
          version: this.options.version,
        });
        this.registered = true;
        this.logger.info(
          {
            event: "WORKER_REGISTERED",
            workerId: this.options.workerId,
          },
          "Worker registered with server",
        );
      }

      const workerState = this.jobProcessor.getState();
      const controllerState = this.jobProcessor.getControllerStatus();

      await this.serverClient.sendHeartbeat({
        workerId: this.options.workerId,
        status: workerState.status,
        currentJobId: workerState.currentJobId,
        photoshopStatus: controllerState.status,
      });

      this.lastSuccessfulHeartbeatAt = new Date().toISOString();
      this.lastError = null;
    } catch (error: unknown) {
      if (error instanceof ServerClientError && error.statusCode === 404) {
        this.registered = false;
      }

      this.lastError = this.normalizeError(error);
      this.logger.error(
        {
          err: error,
          event: "WORKER_SERVER_SYNC_FAILED",
          workerId: this.options.workerId,
          registered: this.registered,
        },
        "Worker could not synchronize with server",
      );
    }
  }

  private scheduleNextCycle(): void {
    if (!this.isStarted || this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.runCycle().catch((error: unknown) => {
        this.lastError = this.normalizeError(error);
        this.logger.error(
          {
            err: error,
            event: "WORKER_COORDINATOR_ERROR",
            workerId: this.options.workerId,
          },
          "Unexpected worker coordinator failure",
        );
      });
    }, this.options.heartbeatIntervalMs);
  }

  private normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 1_000);
  }
}
