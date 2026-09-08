import { createHash, timingSafeEqual } from "node:crypto";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z, type ZodIssue } from "zod";

import {
  completedJobRequestSchema,
  failedJobRequestSchema,
  jobResultParamsSchema,
} from "../domain/job-result.js";
import {
  JobResultError,
  JobService,
} from "../services/job-service.js";
import {
  WorkerRegistry,
  WorkerRegistryError,
} from "../services/worker-registry.js";

const apiKeyHeadersSchema = z
  .object({
    "x-api-key": z.string().min(1),
  })
  .passthrough();

export interface JobResultRoutesOptions {
  jobService: JobService;
  workerRegistry: WorkerRegistry;
  callbackApiKey: string;
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

const sendJobResultError = async (
  error: JobResultError,
  reply: FastifyReply,
): Promise<FastifyReply> =>
  await reply.code(error.code === "JOB_NOT_FOUND" ? 404 : 409).send({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
    },
  });

export const registerJobResultRoutes = async (
  app: FastifyInstance,
  options: JobResultRoutesOptions,
): Promise<void> => {
  const authenticateCallback = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const parsedHeaders = apiKeyHeadersSchema.safeParse(request.headers);

    if (
      !parsedHeaders.success ||
      !apiKeysMatch(parsedHeaders.data["x-api-key"], options.callbackApiKey)
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

  const reconcileWorker = (
    workerId: string,
    jobId: string,
    request: FastifyRequest,
  ): void => {
    const worker = options.workerRegistry.getWorker(workerId);

    if (!worker) {
      request.log.warn(
        {
          event: "JOB_RESULT_WORKER_NOT_REGISTERED",
          jobId,
          workerId,
        },
        "Job result was accepted but the worker is not registered",
      );
      return;
    }

    if (worker.currentJobId === null && worker.status === "IDLE") {
      return;
    }

    if (worker.currentJobId !== jobId) {
      request.log.warn(
        {
          event: "JOB_RESULT_WORKER_MISMATCH",
          jobId,
          workerId,
          currentJobId: worker.currentJobId,
        },
        "A delayed job result did not release the worker's current job",
      );
      return;
    }

    try {
      options.workerRegistry.releaseWorker(workerId, jobId);
    } catch (error: unknown) {
      if (error instanceof WorkerRegistryError) {
        request.log.warn(
          {
            err: error,
            event: "JOB_RESULT_WORKER_RELEASE_FAILED",
            jobId,
            workerId,
          },
          "Job result was accepted but the worker could not be released",
        );
        return;
      }

      throw error;
    }
  };

  app.post(
    "/api/jobs/:jobId/completed",
    { preHandler: authenticateCallback },
    async (request, reply) => {
      const parsedParams = jobResultParamsSchema.safeParse(request.params);
      const parsedBody = completedJobRequestSchema.safeParse(request.body);

      if (!parsedParams.success || !parsedBody.success) {
        const issues = [
          ...(parsedParams.success ? [] : parsedParams.error.issues),
          ...(parsedBody.success ? [] : parsedBody.error.issues),
        ];

        return await reply.code(400).send({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The completed job callback is invalid",
            details: formatValidationIssues(issues),
          },
        });
      }

      try {
        const update = options.jobService.completeJob(
          parsedParams.data.jobId,
          parsedBody.data,
        );
        reconcileWorker(
          parsedBody.data.workerId,
          parsedParams.data.jobId,
          request,
        );

        return await reply.code(200).send({
          ok: true,
          jobId: update.job.id,
          status: update.job.status,
          duplicate: update.duplicate,
        });
      } catch (error: unknown) {
        if (error instanceof JobResultError) {
          return await sendJobResultError(error, reply);
        }

        throw error;
      }
    },
  );

  app.post(
    "/api/jobs/:jobId/failed",
    { preHandler: authenticateCallback },
    async (request, reply) => {
      const parsedParams = jobResultParamsSchema.safeParse(request.params);
      const parsedBody = failedJobRequestSchema.safeParse(request.body);

      if (!parsedParams.success || !parsedBody.success) {
        const issues = [
          ...(parsedParams.success ? [] : parsedParams.error.issues),
          ...(parsedBody.success ? [] : parsedBody.error.issues),
        ];

        return await reply.code(400).send({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The failed job callback is invalid",
            details: formatValidationIssues(issues),
          },
        });
      }

      try {
        const update = options.jobService.failJob(
          parsedParams.data.jobId,
          parsedBody.data,
        );
        reconcileWorker(
          parsedBody.data.workerId,
          parsedParams.data.jobId,
          request,
        );

        return await reply.code(200).send({
          ok: true,
          jobId: update.job.id,
          status: update.job.status,
          duplicate: update.duplicate,
        });
      } catch (error: unknown) {
        if (error instanceof JobResultError) {
          return await sendJobResultError(error, reply);
        }

        throw error;
      }
    },
  );
};
