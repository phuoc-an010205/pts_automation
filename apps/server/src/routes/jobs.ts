import { createHash, timingSafeEqual } from "node:crypto";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z, type ZodIssue } from "zod";

import { createJobRequestSchema } from "../domain/job.js";
import { JobService } from "../services/job-service.js";

const apiKeyHeadersSchema = z
  .object({
    "x-api-key": z.string().min(1),
  })
  .passthrough();

const jobParamsSchema = z
  .object({
    jobId: z.string().trim().min(1).max(100),
  })
  .strict();

export interface JobRoutesOptions {
  jobService: JobService;
  serverApiKey: string;
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

const statusLabel = (status: string): string => {
  const map: Record<string, string> = {
    QUEUED: "Máy trống",
    ASSIGNED: "Máy trống",
    PROCESSING: "Máy đang thực thi",
    COMPLETED: "Máy xử lí xong",
    FAILED: "Máy đang bị lỗi",
  };
  return map[status] ?? status;
};

export const registerJobRoutes = async (
  app: FastifyInstance,
  options: JobRoutesOptions,
): Promise<void> => {
  const authenticateRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const parsedHeaders = apiKeyHeadersSchema.safeParse(request.headers);

    if (
      !parsedHeaders.success ||
      !apiKeysMatch(parsedHeaders.data["x-api-key"], options.serverApiKey)
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

  app.post(
    "/api/jobs",
    { preHandler: authenticateRequest },
    async (request, reply) => {
      const parsedRequest = createJobRequestSchema.safeParse(request.body);

      if (!parsedRequest.success) {
        return await reply.code(400).send({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The job request is invalid",
            details: formatValidationIssues(parsedRequest.error.issues),
          },
        });
      }

      try {
        const result = await options.jobService.submitJob(parsedRequest.data);

        return await reply.code(result.duplicate ? 200 : 202).send({
          ok: true,
          jobId: result.job.id,
          status: result.job.status,
          duplicate: result.duplicate,
        });
      } catch (error: unknown) {
        throw error;
      }
    },
  );

  app.get(
    "/api/jobs",
    { preHandler: authenticateRequest },
    async (_request, reply) => {
      const jobs = options.jobService.listJobs().map((job) => ({
        id: job.id,
        status: statusLabel(job.status),
        itemCode: job.request.itemCode,
        action: job.request.action,
        productType: job.request.productType,
        assignedWorkerId: job.assignedWorkerId,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        error: job.error,
      }));
      return await reply.code(200).send({ ok: true, jobs });
    },
  );

  app.get(
    "/api/jobs/:jobId",
    { preHandler: authenticateRequest },
    async (request, reply) => {
      const parsedParams = jobParamsSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return await reply.code(400).send({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The job ID is invalid",
            details: formatValidationIssues(parsedParams.error.issues),
          },
        });
      }

      const job = options.jobService.getJob(parsedParams.data.jobId);

      if (!job) {
        return await reply.code(404).send({
          ok: false,
          error: {
            code: "JOB_NOT_FOUND",
            message: "The requested job does not exist in runtime memory",
          },
        });
      }

      return await reply.code(200).send({
        ok: true,
        job: {
          id: job.id,
          status: statusLabel(job.status),
          itemCode: job.request.itemCode,
          action: job.request.action,
          productType: job.request.productType,
          assignedWorkerId: job.assignedWorkerId,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          error: job.error,
        },
      });
    },
  );

  const claimJobRequestSchema = z
    .object({
      workerId: z.string().trim().min(1).max(100),
    })
    .strict();

  app.post(
    "/api/jobs/claim",
    { preHandler: authenticateRequest },
    async (request, reply) => {
      const parsedRequest = claimJobRequestSchema.safeParse(request.body);

      if (!parsedRequest.success) {
        return await reply.code(400).send({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The claim request is invalid",
            details: formatValidationIssues(parsedRequest.error.issues),
          },
        });
      }

      const job = options.jobService.claimNextJob(parsedRequest.data.workerId);

      if (!job) {
        return await reply.code(204).send();
      }

      return await reply.code(200).send({
        ok: true,
        job,
      });
    },
  );
};
