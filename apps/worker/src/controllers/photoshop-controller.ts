import type { WorkerJobRequest } from "../domain/job.js";

export type PhotoshopStatus =
  | "NOT_RUNNING"
  | "STARTING"
  | "READY"
  | "RUNNING"
  | "ERROR";

export interface PhotoshopControllerStatus {
  status: PhotoshopStatus;
  lastError: string | null;
}

export interface PhotoshopExecutionResult {
  jobId: string;
  completedAt: string;
  outputFiles: string[];
  details: Record<string, unknown>;
}

export interface PhotoshopController {
  isRunning(): boolean;
  isReady(): boolean;
  start(): Promise<void>;
  executeJob(
    job: WorkerJobRequest,
    signal?: AbortSignal,
  ): Promise<PhotoshopExecutionResult>;
  getStatus(): PhotoshopControllerStatus;
  stop(): Promise<void>;
}

export class PhotoshopControllerError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PhotoshopControllerError";
  }
}

export class MockPhotoshopController implements PhotoshopController {
  private readonly processingTimeMs: number;
  private status: PhotoshopStatus = "NOT_RUNNING";
  private lastError: string | null = null;

  public constructor(processingTimeMs: number) {
    if (!Number.isInteger(processingTimeMs) || processingTimeMs < 0) {
      throw new PhotoshopControllerError(
        "processingTimeMs must be a non-negative integer",
      );
    }

    this.processingTimeMs = processingTimeMs;
  }

  public isRunning(): boolean {
    return this.status !== "NOT_RUNNING";
  }

  public isReady(): boolean {
    return this.status === "READY";
  }

  public async start(): Promise<void> {
    if (this.status === "READY" || this.status === "RUNNING") {
      return;
    }

    this.status = "STARTING";
    this.lastError = null;

    try {
      await Promise.resolve();
      this.status = "READY";
    } catch (error: unknown) {
      this.status = "ERROR";
      this.lastError = this.normalizeError(error);
      throw new PhotoshopControllerError(
        "Mock Photoshop controller failed to start",
        { cause: error },
      );
    }
  }

  public async executeJob(
    job: WorkerJobRequest,
    signal?: AbortSignal,
  ): Promise<PhotoshopExecutionResult> {
    if (!this.isReady()) {
      throw new PhotoshopControllerError(
        `Mock Photoshop controller is not ready; current status is ${this.status}`,
      );
    }

    this.status = "RUNNING";
    this.lastError = null;

    try {
      await this.waitForProcessing(signal);

      return {
        jobId: job.jobId,
        completedAt: new Date().toISOString(),
        outputFiles: [],
        details: {
          controller: "mock",
          processingTimeMs: this.processingTimeMs,
        },
      };
    } catch (error: unknown) {
      this.lastError = this.normalizeError(error);
      throw new PhotoshopControllerError(
        `Mock processing failed for job ${job.jobId}`,
        { cause: error },
      );
    } finally {
      if (this.status === "RUNNING") {
        this.status = "READY";
      }
    }
  }

  public getStatus(): PhotoshopControllerStatus {
    return {
      status: this.status,
      lastError: this.lastError,
    };
  }

  public async stop(): Promise<void> {
    if (this.status === "RUNNING") {
      throw new PhotoshopControllerError(
        "Cannot stop the mock Photoshop controller while a job is running",
      );
    }

    await Promise.resolve();
    this.status = "NOT_RUNNING";
    this.lastError = null;
  }

  private async waitForProcessing(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw this.createAbortError(signal);
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", handleAbort);
        resolve();
      }, this.processingTimeMs);

      const handleAbort = (): void => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", handleAbort);
        reject(this.createAbortError(signal));
      };

      signal?.addEventListener("abort", handleAbort, { once: true });
    });
  }

  private createAbortError(signal?: AbortSignal): Error {
    return signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("Job processing was aborted", "AbortError");
  }

  private normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 1_000);
  }
}
