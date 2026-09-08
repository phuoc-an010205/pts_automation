import { z } from "zod";

import type { WorkerJobRequest } from "../domain/job.js";

const workerAcknowledgementSchema = z
  .object({
    ok: z.literal(true),
    accepted: z.literal(true),
    workerId: z.string().trim().min(1).max(100),
    jobId: z.string().trim().min(1).max(100),
    status: z.enum(["ACCEPTED", "PROCESSING"]),
  })
  .strict();

const workerErrorSchema = z
  .object({
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export type WorkerAcknowledgement = z.infer<
  typeof workerAcknowledgementSchema
>;

export interface WorkerClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export class WorkerClientError extends Error {
  public readonly statusCode: number | null;
  public readonly retryable: boolean;

  public constructor(
    message: string,
    options: {
      statusCode?: number;
      retryable: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "WorkerClientError";
    this.statusCode = options.statusCode ?? null;
    this.retryable = options.retryable;
  }
}

export class WorkerClient {
  private readonly jobEndpoint: URL;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  public constructor(options: WorkerClientOptions) {
    this.jobEndpoint = new URL(
      "job",
      `${options.baseUrl.replace(/\/$/, "")}/`,
    );
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
  }

  public async dispatchJob(
    job: WorkerJobRequest,
  ): Promise<WorkerAcknowledgement> {
    let response: Response;

    try {
      response = await fetch(this.jobEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      const timedOut =
        error instanceof DOMException && error.name === "TimeoutError";
      const message = timedOut
        ? `Worker request timed out after ${this.timeoutMs}ms`
        : "Unable to connect to the worker";

      throw new WorkerClientError(message, {
        retryable: true,
        cause: error,
      });
    }

    const responseBody = await this.readResponseBody(response);

    if (!response.ok) {
      const workerMessage = this.extractWorkerError(responseBody);
      const detail = workerMessage
        ? `: ${workerMessage}`
        : response.statusText
          ? `: ${response.statusText}`
          : "";

      throw new WorkerClientError(
        `Worker rejected the job with HTTP ${response.status}${detail}`,
        {
          statusCode: response.status,
          retryable: response.status === 409 || response.status >= 500,
        },
      );
    }

    let decodedBody: unknown;

    try {
      decodedBody = JSON.parse(responseBody) as unknown;
    } catch (error: unknown) {
      throw new WorkerClientError("Worker returned invalid JSON", {
        statusCode: response.status,
        retryable: false,
        cause: error,
      });
    }

    const acknowledgement = workerAcknowledgementSchema.safeParse(decodedBody);

    if (!acknowledgement.success) {
      throw new WorkerClientError(
        "Worker returned an invalid acknowledgement payload",
        {
          statusCode: response.status,
          retryable: false,
          cause: acknowledgement.error,
        },
      );
    }

    if (acknowledgement.data.jobId !== job.jobId) {
      throw new WorkerClientError(
        `Worker acknowledged a different job: ${acknowledgement.data.jobId}`,
        {
          statusCode: response.status,
          retryable: false,
        },
      );
    }

    return acknowledgement.data;
  }

  private async readResponseBody(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch (error: unknown) {
      throw new WorkerClientError("Unable to read the worker response", {
        statusCode: response.status,
        retryable: true,
        cause: error,
      });
    }
  }

  private extractWorkerError(responseBody: string): string | null {
    if (responseBody.length === 0) {
      return null;
    }

    try {
      const decodedBody = JSON.parse(responseBody) as unknown;
      const parsedError = workerErrorSchema.safeParse(decodedBody);

      if (parsedError.success) {
        const message = parsedError.data.error ?? parsedError.data.message;
        return message ? message.slice(0, 500) : null;
      }
    } catch {
      return responseBody.slice(0, 500);
    }

    return null;
  }
}
