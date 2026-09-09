import { createHash, timingSafeEqual } from "node:crypto";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z, type ZodIssue } from "zod";

import { workerJobRequestSchema } from "../domain/job.js";
import { JobProcessor } from "../services/job-processor.js";
import { WorkerCoordinator } from "../services/worker-coordinator.js";

const apiKeyHeadersSchema = z
  .object({
    "x-api-key": z.string().min(1),
  })
  .passthrough();

const cancelJobRequestSchema = z
  .object({
    jobId: z.string().trim().min(1).max(100),
  })
  .strict();

export interface WorkerRoutesOptions {
  workerId: string;
  workerApiKey: string;
  jobProcessor: JobProcessor;
  workerCoordinator: WorkerCoordinator | null;
}

interface ValidationDetail {
  path: string;
  message: string;
}

const formatValidationIssues = (issues: ZodIssue[]): ValidationDetail[] =>
  issues.map((issue) => ({
    path: issue.path.join(".") || "request",
    message: issue.message,
  }));

const apiKeysMatch = (providedApiKey: string, expectedApiKey: string): boolean => {
  const providedDigest = createHash("sha256").update(providedApiKey).digest();
  const expectedDigest = createHash("sha256").update(expectedApiKey).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
};

export const registerWorkerRoutes = async (
  app: FastifyInstance,
  options: WorkerRoutesOptions,
): Promise<void> => {
  const authenticateRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const parsedHeaders = apiKeyHeadersSchema.safeParse(request.headers);

    if (
      !parsedHeaders.success ||
      !apiKeysMatch(parsedHeaders.data["x-api-key"], options.workerApiKey)
    ) {
      await reply.code(401).send({
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "A valid API key is required",
        },
      });
    }
  };

  app.get("/health", async (_request, reply) => {
    const workerState = options.jobProcessor.getState();
    const isHealthy =
      workerState.status === "QUEUED" || workerState.status === "RUNNING";

    return await reply.code(isHealthy ? 200 : 503).send({
      ok: isHealthy,
      service: "pts-worker",
      workerId: options.workerId,
      status: workerState.status,
      timestamp: new Date().toISOString(),
    });
  });

  app.get(
    "/status",
    { preHandler: authenticateRequest },
    async (_request, reply) =>
      await reply.code(200).send({
        ok: true,
        worker: options.jobProcessor.getState(),
        photoshop: options.jobProcessor.getControllerStatus(),
        serverConnection: options.workerCoordinator?.getConnectionState() ?? {
          registered: false,
          lastSuccessfulHeartbeatAt: null,
          lastError: null,
        },
        pendingReports: options.jobProcessor.getPendingReports(),
      }),
  );

  app.post(
    "/job",
    { preHandler: authenticateRequest },
    async (request, reply) => {
      const parsedJob = workerJobRequestSchema.safeParse(request.body);

      if (!parsedJob.success) {
        return await reply.code(400).send({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The worker job payload is invalid",
            details: formatValidationIssues(parsedJob.error.issues),
          },
        });
      }

      const claim = options.jobProcessor.submitJob(parsedJob.data);

      if (claim.kind === "BUSY") {
        return await reply.code(409).send({
          ok: false,
          error: {
            code: "WORKER_BUSY",
            message: "The worker is already processing another job",
          },
          currentJobId: claim.currentJobId,
        });
      }

      if (claim.kind === "NOT_READY") {
        return await reply.code(503).send({
          ok: false,
          error: {
            code: "WORKER_NOT_READY",
            message: `The worker cannot accept jobs while status is ${claim.status}`,
          },
        });
      }

      if (claim.kind === "DUPLICATE_TERMINAL") {
        return await reply.code(200).send({
          ok: true,
          accepted: true,
          duplicate: true,
          workerId: options.workerId,
          jobId: claim.jobId,
          status: claim.outcome,
        });
      }

      return await reply.code(claim.kind === "CLAIMED" ? 202 : 200).send({
        ok: true,
        accepted: true,
        duplicate: claim.kind === "DUPLICATE_ACTIVE",
        workerId: options.workerId,
        jobId: claim.job.jobId,
        status: "PROCESSING",
      });
    },
  );

  app.post(
    "/cancel",
    { preHandler: authenticateRequest },
    async (request, reply) => {
      const parsedRequest = cancelJobRequestSchema.safeParse(request.body);

      if (!parsedRequest.success) {
        return await reply.code(400).send({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The cancel request is invalid",
            details: formatValidationIssues(parsedRequest.error.issues),
          },
        });
      }

      const result = options.jobProcessor.cancelJob(parsedRequest.data.jobId);

      if (result.cancelled) {
        return await reply.code(202).send({
          ok: true,
          jobId: result.jobId,
          status: "CANCELLING",
        });
      }

      if (result.reason === "JOB_ID_MISMATCH") {
        return await reply.code(409).send({
          ok: false,
          error: {
            code: "JOB_ID_MISMATCH",
            message: "The worker is processing a different job",
          },
          currentJobId: result.currentJobId,
        });
      }

      return await reply.code(404).send({
        ok: false,
        error: {
          code: "NO_ACTIVE_JOB",
          message: "The worker has no active job to cancel",
        },
      });
    },
  );
};
