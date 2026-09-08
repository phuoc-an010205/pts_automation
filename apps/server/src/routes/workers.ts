import { createHash, timingSafeEqual } from "node:crypto";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z, type ZodIssue } from "zod";

import {
  registerWorkerRequestSchema,
  workerHeartbeatRequestSchema,
} from "../domain/worker.js";
import {
  WorkerRegistry,
  WorkerRegistryError,
} from "../services/worker-registry.js";

const apiKeyHeadersSchema = z
  .object({
    "x-api-key": z.string().min(1),
  })
  .passthrough();

const workerParamsSchema = z
  .object({
    workerId: z.string().trim().min(1).max(100),
  })
  .strict();

export interface WorkerRoutesOptions {
  workerRegistry: WorkerRegistry;
  callbackApiKey: string;
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

const createAuthenticator = (expectedApiKey: string) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const parsedHeaders = apiKeyHeadersSchema.safeParse(request.headers);

    if (
      !parsedHeaders.success ||
      !apiKeysMatch(parsedHeaders.data["x-api-key"], expectedApiKey)
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

const sendRegistryError = async (
  error: WorkerRegistryError,
  reply: FastifyReply,
): Promise<FastifyReply> => {
  const statusCode =
    error.code === "WORKER_NOT_REGISTERED"
      ? 404
      : error.code === "INVALID_HEARTBEAT"
        ? 400
        : 409;

  return await reply.code(statusCode).send({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
    },
  });
};

export const registerWorkerRoutes = async (
  app: FastifyInstance,
  options: WorkerRoutesOptions,
): Promise<void> => {
  const authenticateCallback = createAuthenticator(options.callbackApiKey);
  const authenticateServerApi = createAuthenticator(options.serverApiKey);

  app.post(
    "/api/workers/register",
    { preHandler: authenticateCallback },
    async (request, reply) => {
      const parsedRequest = registerWorkerRequestSchema.safeParse(request.body);

      if (!parsedRequest.success) {
        return await reply.code(400).send({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The worker registration payload is invalid",
            details: formatValidationIssues(parsedRequest.error.issues),
          },
        });
      }

      const result = options.workerRegistry.registerWorker(parsedRequest.data);

      return await reply.code(200).send({
        ok: true,
        worker: result.worker,
        interruptedJobId: result.interruptedJobId,
      });
    },
  );

  app.post(
    "/api/workers/heartbeat",
    { preHandler: authenticateCallback },
    async (request, reply) => {
      const parsedRequest = workerHeartbeatRequestSchema.safeParse(request.body);

      if (!parsedRequest.success) {
        return await reply.code(400).send({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The worker heartbeat payload is invalid",
            details: formatValidationIssues(parsedRequest.error.issues),
          },
        });
      }

      try {
        const worker = options.workerRegistry.recordHeartbeat(parsedRequest.data);

        return await reply.code(200).send({
          ok: true,
          worker,
        });
      } catch (error: unknown) {
        if (error instanceof WorkerRegistryError) {
          return await sendRegistryError(error, reply);
        }

        throw error;
      }
    },
  );

  app.get(
    "/api/workers",
    { preHandler: authenticateServerApi },
    async (_request, reply) => {
      options.workerRegistry.markOfflineWorkers();

      return await reply.code(200).send({
        ok: true,
        workers: options.workerRegistry.listWorkers(),
      });
    },
  );

  app.get(
    "/api/workers/:workerId",
    { preHandler: authenticateServerApi },
    async (request, reply) => {
      const parsedParams = workerParamsSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return await reply.code(400).send({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The worker ID is invalid",
            details: formatValidationIssues(parsedParams.error.issues),
          },
        });
      }

      options.workerRegistry.markOfflineWorkers();
      const worker = options.workerRegistry.getWorker(
        parsedParams.data.workerId,
      );

      if (!worker) {
        return await reply.code(404).send({
          ok: false,
          error: {
            code: "WORKER_NOT_FOUND",
            message: "The requested worker is not registered",
          },
        });
      }

      return await reply.code(200).send({
        ok: true,
        worker,
      });
    },
  );
};
