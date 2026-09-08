import { randomUUID } from "node:crypto";

import type {
  CompletedJobRequest,
  FailedJobRequest,
  RuntimeJobResult,
} from "../domain/job-result.js";
import type {
  CreateJobRequest,
  RuntimeJob,
} from "../domain/job.js";

export interface JobSubmissionResult {
  job: RuntimeJob;
  duplicate: boolean;
}

export type JobResultErrorCode =
  | "JOB_NOT_FOUND"
  | "WORKER_MISMATCH"
  | "INVALID_JOB_STATE"
  | "JOB_TERMINAL_CONFLICT";

export interface JobResultUpdate {
  job: RuntimeJob;
  result: RuntimeJobResult;
  duplicate: boolean;
}

export class JobResultError extends Error {
  public readonly code: JobResultErrorCode;

  public constructor(code: JobResultErrorCode, message: string) {
    super(message);
    this.name = "JobResultError";
    this.code = code;
  }
}

export class JobService {
  private readonly jobs = new Map<string, RuntimeJob>();
  private readonly jobIdsByIdempotencyKey = new Map<string, string>();
  private readonly jobResults = new Map<string, RuntimeJobResult>();
  private onJobCreated: ((job: RuntimeJob) => void) | null = null;

  public constructor() {}

  public setJobCreatedListener(listener: (job: RuntimeJob) => void): void {
    this.onJobCreated = listener;
  }

  public async submitJob(
    request: CreateJobRequest,
  ): Promise<JobSubmissionResult> {
    const duplicateJob = this.findByIdempotencyKey(request.idempotencyKey);

    if (duplicateJob) {
      return {
        job: structuredClone(duplicateJob),
        duplicate: true,
      };
    }

    const timestamp = new Date().toISOString();
    const job: RuntimeJob = {
      id: this.createJobId(),
      status: "QUEUED",
      request: structuredClone(request),
      assignedWorkerId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      error: null,
    };

    this.jobs.set(job.id, job);

    if (request.idempotencyKey) {
      this.jobIdsByIdempotencyKey.set(request.idempotencyKey, job.id);
    }

    if (this.onJobCreated) {
      this.onJobCreated(structuredClone(job));
    }

    return {
      job: structuredClone(job),
      duplicate: false,
    };
  }

  public getJob(jobId: string): RuntimeJob | null {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : null;
  }

  public listJobs(): RuntimeJob[] {
    return Array.from(this.jobs.values(), (job) => structuredClone(job)).sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt),
    );
  }

  public claimNextJob(workerId: string): RuntimeJob | null {
    const queuedJobs = Array.from(this.jobs.values())
      .filter((job) => job.status === "QUEUED")
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt),
      );

    const job = queuedJobs[0];

    if (!job) {
      return null;
    }

    const claimedJob = this.updateJob(job.id, {
      status: "PROCESSING",
      assignedWorkerId: workerId,
      error: null,
    });

    return structuredClone(claimedJob);
  }

  public completeJob(
    jobId: string,
    request: CompletedJobRequest,
  ): JobResultUpdate {
    const job = this.requireJob(jobId);
    const existingResult = this.jobResults.get(jobId);

    if (existingResult) {
      return this.resolveDuplicateResult(
        job,
        existingResult,
        "COMPLETED",
        request.workerId,
      );
    }

    this.assertAssignedWorker(job, request.workerId);
    this.assertJobAcceptsResult(job);

    const result: RuntimeJobResult = {
      status: "COMPLETED",
      workerId: request.workerId,
      completedAt: request.completedAt,
      result: structuredClone(request.result),
      outputFiles: structuredClone(request.outputFiles),
    };
    const completedJob = this.updateJob(jobId, {
      status: "COMPLETED",
      error: null,
    });
    this.jobResults.set(jobId, result);

    return {
      job: structuredClone(completedJob),
      result: structuredClone(result),
      duplicate: false,
    };
  }

  public failJob(jobId: string, request: FailedJobRequest): JobResultUpdate {
    const job = this.requireJob(jobId);
    const existingResult = this.jobResults.get(jobId);

    if (existingResult) {
      return this.resolveDuplicateResult(
        job,
        existingResult,
        "FAILED",
        request.workerId,
      );
    }

    this.assertAssignedWorker(job, request.workerId);
    this.assertJobAcceptsResult(job);

    const result: RuntimeJobResult = {
      status: "FAILED",
      workerId: request.workerId,
      failedAt: new Date().toISOString(),
      errorCode: request.errorCode,
      error: request.error,
    };
    const failedJob = this.updateJob(jobId, {
      status: "FAILED",
      error: request.error,
    });
    this.jobResults.set(jobId, result);

    return {
      job: structuredClone(failedJob),
      result: structuredClone(result),
      duplicate: false,
    };
  }

  public getJobResult(jobId: string): RuntimeJobResult | null {
    const result = this.jobResults.get(jobId);
    return result ? structuredClone(result) : null;
  }

  private findByIdempotencyKey(
    idempotencyKey: string | undefined,
  ): RuntimeJob | null {
    if (!idempotencyKey) {
      return null;
    }

    const jobId = this.jobIdsByIdempotencyKey.get(idempotencyKey);

    if (!jobId) {
      return null;
    }

    return this.jobs.get(jobId) ?? null;
  }

  private requireJob(jobId: string): RuntimeJob {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new JobResultError(
        "JOB_NOT_FOUND",
        `Runtime job ${jobId} does not exist`,
      );
    }

    return job;
  }

  private assertAssignedWorker(job: RuntimeJob, workerId: string): void {
    if (job.assignedWorkerId !== workerId) {
      throw new JobResultError(
        "WORKER_MISMATCH",
        `Worker ${workerId} is not assigned to job ${job.id}`,
      );
    }
  }

  private assertJobAcceptsResult(job: RuntimeJob): void {
    if (job.status !== "ASSIGNED" && job.status !== "PROCESSING") {
      throw new JobResultError(
        "INVALID_JOB_STATE",
        `Job ${job.id} cannot accept a result while status is ${job.status}`,
      );
    }
  }

  private resolveDuplicateResult(
    job: RuntimeJob,
    existingResult: RuntimeJobResult,
    incomingStatus: RuntimeJobResult["status"],
    workerId: string,
  ): JobResultUpdate {
    if (
      existingResult.status !== incomingStatus ||
      existingResult.workerId !== workerId
    ) {
      throw new JobResultError(
        "JOB_TERMINAL_CONFLICT",
        `Job ${job.id} already has a different terminal result`,
      );
    }

    return {
      job: structuredClone(job),
      result: structuredClone(existingResult),
      duplicate: true,
    };
  }

  private updateJob(
    jobId: string,
    changes: Pick<RuntimeJob, "status" | "error"> &
      Partial<Pick<RuntimeJob, "assignedWorkerId">>,
  ): RuntimeJob {
    const currentJob = this.jobs.get(jobId);

    if (!currentJob) {
      throw new Error(`Cannot update missing runtime job ${jobId}`);
    }

    const updatedJob: RuntimeJob = {
      ...currentJob,
      ...changes,
      updatedAt: new Date().toISOString(),
    };

    this.jobs.set(jobId, updatedJob);
    return updatedJob;
  }

  private createJobId(): string {
    return `JOB-${randomUUID().toUpperCase()}`;
  }
}
