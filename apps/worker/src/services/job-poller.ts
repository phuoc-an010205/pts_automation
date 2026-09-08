export interface PolledJob {
  id: string;
  status: string;
  createdAt: string;
  request: {
    orderNumber: string;
    lineItemId: string;
    sku: string;
    productType: string;
    data: Record<string, unknown>;
  };
}

export interface JobPollerOptions {
  serverBaseUrl: string;
  serverApiKey: string;
  workerId: string;
  pollIntervalMs: number;
  onJob: (job: PolledJob) => Promise<void>;
  logger: JobPollerLogger;
}

export interface JobPollerLogger {
  info(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export class JobPoller {
  private readonly serverBaseUrl: string;
  private readonly serverApiKey: string;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly onJob: (job: PolledJob) => Promise<void>;
  private readonly logger: JobPollerLogger;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;

  public constructor(options: JobPollerOptions) {
    this.serverBaseUrl = options.serverBaseUrl.replace(/\/$/, "");
    this.serverApiKey = options.serverApiKey;
    this.workerId = options.workerId;
    this.pollIntervalMs = options.pollIntervalMs;
    this.onJob = options.onJob;
    this.logger = options.logger;
  }

  public start(): void {
    if (this.pollTimer) {
      return;
    }

    this.logger.info(
      { event: "JOB_POLLER_STARTED", pollIntervalMs: this.pollIntervalMs },
      "Job poller started",
    );

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  public stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.logger.info({ event: "JOB_POLLER_STOPPED" }, "Job poller stopped");
  }

  private async poll(): Promise<void> {
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;

    try {
      const response = await fetch(`${this.serverBaseUrl}/api/jobs/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.serverApiKey,
        },
        body: JSON.stringify({ workerId: this.workerId }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 204) {
        return;
      }

      if (!response.ok) {
        this.logger.error(
          { event: "JOB_POLL_FAILED", status: response.status },
          "Failed to poll for jobs",
        );
        return;
      }

      const data = (await response.json()) as { ok: boolean; job?: PolledJob };

      if (data.ok && data.job) {
        this.logger.info(
          { event: "JOB_RECEIVED", jobId: data.job.id },
          "Received job from server",
        );

        await this.onJob(data.job);
      }
    } catch (error: unknown) {
      this.logger.error(
        { event: "JOB_POLL_ERROR", err: error },
        "Error polling for jobs",
      );
    } finally {
      this.isPolling = false;
    }
  }
}
