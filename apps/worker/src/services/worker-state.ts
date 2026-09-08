import type {
  WorkerJobRequest,
  WorkerRuntimeStatus,
} from "../domain/job.js";

export type TerminalJobOutcome = "COMPLETED" | "FAILED";

export type JobClaimResult =
  | {
      kind: "CLAIMED";
      job: WorkerJobRequest;
    }
  | {
      kind: "DUPLICATE_ACTIVE";
      job: WorkerJobRequest;
    }
  | {
      kind: "DUPLICATE_TERMINAL";
      jobId: string;
      outcome: TerminalJobOutcome;
    }
  | {
      kind: "BUSY";
      currentJobId: string;
    }
  | {
      kind: "NOT_READY";
      status: Exclude<WorkerRuntimeStatus, "IDLE" | "BUSY">;
    };

export interface WorkerStateSnapshot {
  workerId: string;
  status: WorkerRuntimeStatus;
  currentJobId: string | null;
  lastJobId: string | null;
  lastJobOutcome: TerminalJobOutcome | null;
  lastError: string | null;
  updatedAt: string;
}

interface TerminalJobRecord {
  outcome: TerminalJobOutcome;
  finishedAt: string;
}

export class WorkerStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkerStateError";
  }
}

export class WorkerState {
  private readonly workerId: string;
  private readonly terminalJobLimit: number;
  private readonly terminalJobs = new Map<string, TerminalJobRecord>();
  private status: WorkerRuntimeStatus = "STARTING";
  private currentJob: WorkerJobRequest | null = null;
  private lastJobId: string | null = null;
  private lastJobOutcome: TerminalJobOutcome | null = null;
  private lastError: string | null = null;
  private updatedAt = new Date().toISOString();

  public constructor(workerId: string, terminalJobLimit = 1_000) {
    if (workerId.trim().length === 0) {
      throw new WorkerStateError("workerId is required");
    }

    if (!Number.isInteger(terminalJobLimit) || terminalJobLimit < 1) {
      throw new WorkerStateError("terminalJobLimit must be a positive integer");
    }

    this.workerId = workerId;
    this.terminalJobLimit = terminalJobLimit;
  }

  public markReady(): void {
    if (this.currentJob) {
      throw new WorkerStateError(
        `Worker ${this.workerId} cannot become IDLE while job ${this.currentJob.jobId} is active`,
      );
    }

    this.status = "IDLE";
    this.lastError = null;
    this.touch();
  }

  public claimJob(job: WorkerJobRequest): JobClaimResult {
    if (this.currentJob?.jobId === job.jobId) {
      return {
        kind: "DUPLICATE_ACTIVE",
        job: structuredClone(this.currentJob),
      };
    }

    const terminalJob = this.terminalJobs.get(job.jobId);

    if (terminalJob) {
      return {
        kind: "DUPLICATE_TERMINAL",
        jobId: job.jobId,
        outcome: terminalJob.outcome,
      };
    }

    if (this.status === "BUSY" && this.currentJob) {
      return {
        kind: "BUSY",
        currentJobId: this.currentJob.jobId,
      };
    }

    if (this.status === "BUSY") {
      throw new WorkerStateError(
        `Worker ${this.workerId} is BUSY without an active job`,
      );
    }

    if (this.status !== "IDLE") {
      return {
        kind: "NOT_READY",
        status: this.status,
      };
    }

    this.currentJob = structuredClone(job);
    this.status = "BUSY";
    this.lastError = null;
    this.touch();

    return {
      kind: "CLAIMED",
      job: structuredClone(this.currentJob),
    };
  }

  public completeJob(jobId: string): void {
    this.assertCurrentJob(jobId);
    this.recordTerminalJob(jobId, "COMPLETED");
    this.currentJob = null;
    this.status = "IDLE";
    this.lastJobId = jobId;
    this.lastJobOutcome = "COMPLETED";
    this.lastError = null;
    this.touch();
  }

  public failJob(jobId: string, error: unknown): void {
    this.assertCurrentJob(jobId);
    this.recordTerminalJob(jobId, "FAILED");
    this.currentJob = null;
    this.status = "IDLE";
    this.lastJobId = jobId;
    this.lastJobOutcome = "FAILED";
    this.lastError = this.normalizeError(error);
    this.touch();
  }

  public markSystemError(error: unknown): void {
    this.currentJob = null;
    this.status = "ERROR";
    this.lastError = this.normalizeError(error);
    this.touch();
  }

  public getCurrentJob(): WorkerJobRequest | null {
    return this.currentJob ? structuredClone(this.currentJob) : null;
  }

  public getSnapshot(): WorkerStateSnapshot {
    return {
      workerId: this.workerId,
      status: this.status,
      currentJobId: this.currentJob?.jobId ?? null,
      lastJobId: this.lastJobId,
      lastJobOutcome: this.lastJobOutcome,
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    };
  }

  private assertCurrentJob(jobId: string): void {
    if (!this.currentJob) {
      throw new WorkerStateError(
        `Worker ${this.workerId} has no active job to finish`,
      );
    }

    if (this.currentJob.jobId !== jobId) {
      throw new WorkerStateError(
        `Worker ${this.workerId} is processing ${this.currentJob.jobId}, not ${jobId}`,
      );
    }
  }

  private recordTerminalJob(
    jobId: string,
    outcome: TerminalJobOutcome,
  ): void {
    this.terminalJobs.set(jobId, {
      outcome,
      finishedAt: new Date().toISOString(),
    });

    while (this.terminalJobs.size > this.terminalJobLimit) {
      const oldestJobId = this.terminalJobs.keys().next().value as
        | string
        | undefined;

      if (!oldestJobId) {
        break;
      }

      this.terminalJobs.delete(oldestJobId);
    }
  }

  private normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 1_000);
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }
}
