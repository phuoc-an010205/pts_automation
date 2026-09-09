import { createHash, timingSafeEqual } from "node:crypto";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import type { WsJobDispatcher } from "../services/ws-job-dispatcher.js";
import type { JobService } from "../services/job-service.js";

const apiKeyHeadersSchema = z
  .object({
    "x-api-key": z.string().min(1),
  })
  .passthrough();

export interface WsWorkerRoutesOptions {
  wsDispatcher: WsJobDispatcher;
  jobService: JobService;
  serverApiKey: string;
}

const apiKeysMatch = (providedApiKey: string, expectedApiKey: string): boolean => {
  const providedDigest = createHash("sha256").update(providedApiKey).digest();
  const expectedDigest = createHash("sha256").update(expectedApiKey).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
};

const wsStatusLabel = (status: string): string => {
  const map: Record<string, string> = {
    QUEUED: "Máy đang trống",
    RUNNING: "Máy đang làm",
    COMPLETED: "Máy hoàn thành",
    FAILED: "Máy đang bị lỗi",
  };
  return map[status] ?? status;
};

export const registerWsWorkerRoutes = async (
  app: FastifyInstance,
  options: WsWorkerRoutesOptions,
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

  app.get(
    "/api/ws-workers",
    { preHandler: authenticateRequest },
    async (_request, reply) => {
      const workers = options.wsDispatcher.getConnectedWorkers();
      return await reply.code(200).send({ ok: true, workers });
    },
  );

  app.get(
    "/api/status",
    { preHandler: authenticateRequest },
    async (_request, reply) => {
      const workers = options.wsDispatcher.getConnectedWorkers();
      const jobs = options.jobService.listJobs();

      const workerStatuses = workers.map((w) => {
        const assignedJob = w.currentJobId
          ? jobs.find((j) => j.id === w.currentJobId)
          : null;

        return {
          workerId: w.workerId,
          wsStatus: wsStatusLabel(w.status),
          currentJobId: w.currentJobId,
          currentJobStatus: assignedJob?.status ?? null,
          currentJobItemCode: assignedJob?.request.itemCode ?? null,
          currentJobAction: assignedJob?.request.action ?? null,
        };
      });

      const pendingJobs = jobs.filter((j) => j.status === "QUEUED").length;
      const processingJobs = jobs.filter((j) => j.status === "PROCESSING").length;
      const completedJobs = jobs.filter((j) => j.status === "COMPLETED").length;
      const failedJobs = jobs.filter((j) => j.status === "FAILED").length;

      return await reply.code(200).send({
        ok: true,
        workers: workerStatuses,
        jobs: {
          total: jobs.length,
          queued: pendingJobs,
          processing: processingJobs,
          completed: completedJobs,
          failed: failedJobs,
        },
      });
    },
  );
};
