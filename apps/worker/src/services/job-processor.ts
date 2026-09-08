import type {
  PhotoshopController,
  PhotoshopControllerStatus,
} from "../controllers/photoshop-controller.js";
import type { WorkerJobRequest } from "../domain/job.js";
import {
  ResultReporter,
  type PendingReportSnapshot,
} from "./result-reporter.js";
import {
  type JobClaimResult,
  WorkerState,
  type WorkerStateSnapshot,
} from "./worker-state.js";

export interface JobProcessorLogger {
  info(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export type CancelJobResult =
  | {
      cancelled: true;
      jobId: string;
    }
  | {
      cancelled: false;
      reason: "NO_ACTIVE_JOB";
    }
  | {
      cancelled: false;
      reason: "JOB_ID_MISMATCH";
      currentJobId: string;
    };

export class JobProcessor {
  private readonly state: WorkerState;
  private readonly controller: PhotoshopController;
  private readonly resultReporter: ResultReporter;
  private readonly logger: JobProcessorLogger;
  private activeAbortController: AbortController | null = null;
  private activeProcessing: Promise<void> | null = null;
  private isShuttingDown = false;

  public constructor(
    state: WorkerState,
    controller: PhotoshopController,
    resultReporter: ResultReporter,
    logger: JobProcessorLogger,
  ) {
    this.state = state;
    this.controller = controller;
    this.resultReporter = resultReporter;
    this.logger = logger;
  }

  public async initialize(): Promise<void> {
    try {
      await this.controller.start();
      this.state.markReady();
    } catch (error: unknown) {
      this.state.markSystemError(error);
      throw error;
    }
  }

  public submitJob(job: WorkerJobRequest): JobClaimResult {
    const claim = this.state.claimJob(job);

    if (claim.kind !== "CLAIMED") {
      return claim;
    }

    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.activeProcessing = this.processJob(claim.job, abortController.signal);

    return claim;
  }

  public cancelJob(jobId: string): CancelJobResult {
    const currentJob = this.state.getCurrentJob();

    if (!currentJob || !this.activeAbortController) {
      return {
        cancelled: false,
        reason: "NO_ACTIVE_JOB",
      };
    }

    if (currentJob.jobId !== jobId) {
      return {
        cancelled: false,
        reason: "JOB_ID_MISMATCH",
        currentJobId: currentJob.jobId,
      };
    }

    this.activeAbortController.abort(
      new Error(`Job ${jobId} was cancelled by request`),
    );

    return {
      cancelled: true,
      jobId,
    };
  }

  public getState(): WorkerStateSnapshot {
    return this.state.getSnapshot();
  }

  public getControllerStatus(): PhotoshopControllerStatus {
    return this.controller.getStatus();
  }

  public getPendingReports(): PendingReportSnapshot[] {
    return this.resultReporter.getPendingReports();
  }

  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      if (this.activeProcessing) {
        await this.activeProcessing;
      }
      return;
    }

    this.isShuttingDown = true;

    if (this.activeAbortController) {
      this.activeAbortController.abort(
        new Error("Worker is shutting down"),
      );
    }

    if (this.activeProcessing) {
      await this.activeProcessing;
    }

    await this.controller.stop();
  }

  private async processJob(
    job: WorkerJobRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const workerId = this.state.getSnapshot().workerId;

    this.logger.info(
      {
        event: "JOB_PROCESSING",
        jobId: job.jobId,
        workerId,
      },
      "Worker started processing job",
    );

    try {
      const result = await this.controller.executeJob(job, signal);

      try {
        this.state.completeJob(job.jobId);
      } catch (stateError: unknown) {
        this.state.markSystemError(stateError);
        this.enqueueFailedReport(
          job.jobId,
          workerId,
          "WORKER_STATE_ERROR",
          stateError,
        );
        this.logger.error(
          {
            err: stateError,
            event: "WORKER_STATE_ERROR",
            jobId: job.jobId,
            workerId,
          },
          "Worker could not record the completed job",
        );
        return;
      }

      try {
        this.resultReporter.enqueueCompleted(workerId, result);
      } catch (reporterError: unknown) {
        this.logger.error(
          {
            err: reporterError,
            event: "JOB_RESULT_QUEUE_ERROR",
            jobId: job.jobId,
            workerId,
          },
          "Worker could not queue the completed result callback",
        );
      }

      this.logger.info(
        {
          event: "JOB_COMPLETED",
          jobId: job.jobId,
          workerId,
          result,
        },
        "Worker completed job",
      );
    } catch (error: unknown) {
      try {
        this.state.failJob(job.jobId, error);
      } catch (stateError: unknown) {
        this.state.markSystemError(stateError);
        this.logger.error(
          {
            err: stateError,
            event: "WORKER_STATE_ERROR",
            jobId: job.jobId,
            workerId,
          },
          "Worker could not record the failed job",
        );
      }

      this.enqueueFailedReport(
        job.jobId,
        workerId,
        signal.aborted ? "JOB_CANCELLED" : "PHOTOSHOP_PROCESSING_FAILED",
        error,
      );

      this.logger.error(
        {
          err: error,
          event: "JOB_FAILED",
          jobId: job.jobId,
          workerId,
        },
        "Worker job processing failed",
      );
    } finally {
      this.activeAbortController = null;
      this.activeProcessing = null;
    }
  }

  private enqueueFailedReport(
    jobId: string,
    workerId: string,
    errorCode: string,
    error: unknown,
  ): void {
    try {
      this.resultReporter.enqueueFailed(jobId, {
        workerId,
        errorCode,
        error: this.normalizeError(error),
      });
    } catch (reporterError: unknown) {
      this.logger.error(
        {
          err: reporterError,
          event: "JOB_RESULT_QUEUE_ERROR",
          jobId,
          workerId,
        },
        "Worker could not queue the failed result callback",
      );
    }
  }

  private normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 1_000);
  }
}
