import { z } from "zod";

import type {
  PhotoshopExecutionResult,
  PhotoshopStatus,
} from "../controllers/photoshop-controller.js";
import type { WorkerRuntimeStatus } from "../domain/job.js";

const serverAcknowledgementSchema = z
  .object({
    ok: z.literal(true),
  })
  .passthrough();

const serverErrorSchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
    message: z.string().optional(),
  })
  .passthrough();

export interface ServerClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export interface RegisterWorkerRequest {
  workerId: string;
  advertisedUrl: string;
  version: string;
}

export interface WorkerHeartbeatRequest {
  workerId: string;
  status: WorkerRuntimeStatus;
  currentJobId: string | null;
  photoshopStatus: PhotoshopStatus;
}

export interface FailedJobReport {
  workerId: string;
  errorCode: string;
  error: string;
}

export class ServerClientError extends Error {
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
    this.name = "ServerClientError";
    this.statusCode = options.statusCode ?? null;
    this.retryable = options.retryable;
  }
}

export class ServerClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  public constructor(options: ServerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
  }

  public async registerWorker(request: RegisterWorkerRequest): Promise<void> {
    await this.post("api/workers/register", request);
  }

  public async sendHeartbeat(request: WorkerHeartbeatRequest): Promise<void> {
    await this.post("api/workers/heartbeat", request);
  }

  public async reportJobCompleted(
    workerId: string,
    result: PhotoshopExecutionResult,
  ): Promise<void> {
    await this.post(`api/jobs/${encodeURIComponent(result.jobId)}/completed`, {
      workerId,
      result: result.details,
      outputFiles: result.outputFiles,
      completedAt: result.completedAt,
    });
  }

  public async reportJobFailed(
    jobId: string,
    report: FailedJobReport,
  ): Promise<void> {
    await this.post(`api/jobs/${encodeURIComponent(jobId)}/failed`, report);
  }

  private async post(path: string, payload: object): Promise<void> {
    const endpoint = new URL(path, `${this.baseUrl}/`);
    let response: Response;

    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      const timedOut =
        error instanceof DOMException && error.name === "TimeoutError";

      throw new ServerClientError(
        timedOut
          ? `Server request timed out after ${this.timeoutMs}ms`
          : "Unable to connect to the server",
        {
          retryable: true,
          cause: error,
        },
      );
    }

    let responseBody: string;

    try {
      responseBody = await response.text();
    } catch (error: unknown) {
      throw new ServerClientError("Unable to read the server response", {
        statusCode: response.status,
        retryable: true,
        cause: error,
      });
    }

    if (!response.ok) {
      const serverMessage = this.extractServerError(responseBody);
      const detail = serverMessage
        ? `: ${serverMessage}`
        : response.statusText
          ? `: ${response.statusText}`
          : "";

      throw new ServerClientError(
        `Server rejected the request with HTTP ${response.status}${detail}`,
        {
          statusCode: response.status,
          retryable: response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
        },
      );
    }

    if (response.status === 204) {
      return;
    }

    let decodedBody: unknown;

    try {
      decodedBody = JSON.parse(responseBody) as unknown;
    } catch (error: unknown) {
      throw new ServerClientError("Server returned invalid JSON", {
        statusCode: response.status,
        retryable: false,
        cause: error,
      });
    }

    const acknowledgement = serverAcknowledgementSchema.safeParse(decodedBody);

    if (!acknowledgement.success) {
      throw new ServerClientError(
        "Server returned an invalid acknowledgement payload",
        {
          statusCode: response.status,
          retryable: false,
          cause: acknowledgement.error,
        },
      );
    }
  }

  private extractServerError(responseBody: string): string | null {
    if (responseBody.length === 0) {
      return null;
    }

    try {
      const decodedBody = JSON.parse(responseBody) as unknown;
      const parsedError = serverErrorSchema.safeParse(decodedBody);

      if (parsedError.success) {
        const message =
          parsedError.data.error?.message ?? parsedError.data.message;
        return message ? message.slice(0, 500) : null;
      }
    } catch {
      return responseBody.slice(0, 500);
    }

    return null;
  }
}
