import type { PhotoshopExecutionResult } from "../controllers/photoshop-controller.js";
import {
  ServerClient,
  ServerClientError,
  type FailedJobReport,
} from "./server-client.js";
import type { WsClient } from "./ws-client.js";

export interface ResultReporterLogger {
  info(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface PendingReportSnapshot {
  jobId: string;
  type: "COMPLETED" | "FAILED";
  attempts: number;
  lastError: string | null;
  queuedAt: string;
}

interface PendingCompletedReport extends PendingReportSnapshot {
  type: "COMPLETED";
  workerId: string;
  result: PhotoshopExecutionResult;
}

interface PendingFailedReport extends PendingReportSnapshot {
  type: "FAILED";
  report: FailedJobReport;
}

type PendingReport = PendingCompletedReport | PendingFailedReport;

export interface ResultReporterOptions {
  serverClient: ServerClient;
  wsClient: WsClient;
  retryIntervalMs: number;
  logger: ResultReporterLogger;
}

export class ResultReporter {
  private readonly serverClient: ServerClient;
  private readonly wsClient: WsClient;
  private readonly retryIntervalMs: number;
  private readonly logger: ResultReporterLogger;
  private readonly pendingReports = new Map<string, PendingReport>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private activeFlush: Promise<void> | null = null;
  private isShuttingDown = false;

  public constructor(options: ResultReporterOptions) {
    if (!Number.isInteger(options.retryIntervalMs) || options.retryIntervalMs < 1_000) {
      throw new Error("retryIntervalMs must be an integer of at least 1000ms");
    }

    this.serverClient = options.serverClient;
    this.wsClient = options.wsClient;
    this.retryIntervalMs = options.retryIntervalMs;
    this.logger = options.logger;
  }

  public enqueueCompleted(
    workerId: string,
    result: PhotoshopExecutionResult,
  ): void {
    this.assertAcceptingReports();
    this.pendingReports.set(result.jobId, {
      jobId: result.jobId,
      type: "COMPLETED",
      workerId,
      result: structuredClone(result),
      attempts: 0,
      lastError: null,
      queuedAt: new Date().toISOString(),
    });
    this.requestFlush();
  }

  public enqueueFailed(jobId: string, report: FailedJobReport): void {
    this.assertAcceptingReports();
    this.pendingReports.set(jobId, {
      jobId,
      type: "FAILED",
      report: structuredClone(report),
      attempts: 0,
      lastError: null,
      queuedAt: new Date().toISOString(),
    });
    this.requestFlush();
  }

  public getPendingReports(): PendingReportSnapshot[] {
    return Array.from(this.pendingReports.values(), (report) => ({
      jobId: report.jobId,
      type: report.type,
      attempts: report.attempts,
      lastError: report.lastError,
      queuedAt: report.queuedAt,
    }));
  }

  public async flush(): Promise<void> {
    if (this.activeFlush) {
      await this.activeFlush;
      return;
    }

    const flushTask = this.flushPendingReports();
    this.activeFlush = flushTask;

    try {
      await flushTask;
    } finally {
      this.activeFlush = null;

      if (!this.isShuttingDown && this.pendingReports.size > 0) {
        this.scheduleRetry();
      }
    }
  }

  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      if (this.activeFlush) {
        await this.activeFlush;
      }
      return;
    }

    this.isShuttingDown = true;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.activeFlush) {
      await this.activeFlush;
    }

    if (this.pendingReports.size > 0) {
      await this.flushPendingReports();
    }
  }

  private requestFlush(): void {
    void this.flush().catch((error: unknown) => {
      this.logger.error(
        {
          err: error,
          event: "RESULT_REPORT_FLUSH_ERROR",
        },
        "Unexpected result reporter flush failure",
      );
    });
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.isShuttingDown) {
      return;
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.requestFlush();
    }, this.retryIntervalMs);
  }

  private async flushPendingReports(): Promise<void> {
    const reports = Array.from(this.pendingReports.values());

    for (const report of reports) {
      try {
        if (this.wsClient.isConnected()) {
          if (report.type === "COMPLETED") {
            this.wsClient.reportJobCompleted(report.jobId);
          } else {
            this.wsClient.reportJobFailed(report.jobId, report.report.error);
          }
        } else {
          if (report.type === "COMPLETED") {
            await this.serverClient.reportJobCompleted(
              report.workerId,
              report.result,
            );
          } else {
            await this.serverClient.reportJobFailed(report.jobId, report.report);
          }
        }

        if (this.pendingReports.get(report.jobId) === report) {
          this.pendingReports.delete(report.jobId);
        }

        this.logger.info(
          {
            event: "JOB_RESULT_REPORTED",
            jobId: report.jobId,
            reportType: report.type,
            via: this.wsClient.isConnected() ? "websocket" : "http",
          },
          "Worker reported job result to server",
        );
      } catch (error: unknown) {
        report.attempts += 1;
        report.lastError = this.normalizeError(error);
        const retryable =
          error instanceof ServerClientError ? error.retryable : false;

        this.logger.error(
          {
            err: error,
            event: "JOB_RESULT_REPORT_FAILED",
            jobId: report.jobId,
            reportType: report.type,
            attempts: report.attempts,
            retryable,
          },
          "Worker could not report job result to server",
        );
      }
    }
  }

  private assertAcceptingReports(): void {
    if (this.isShuttingDown) {
      throw new Error("Result reporter is shutting down");
    }
  }

  private normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 1_000);
  }
}
