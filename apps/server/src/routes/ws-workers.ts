import { createHash, timingSafeEqual } from "node:crypto";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import type { WsJobDispatcher } from "../services/ws-job-dispatcher.js";

const apiKeyHeadersSchema = z
  .object({
    "x-api-key": z.string().min(1),
  })
  .passthrough();

export interface WsWorkerRoutesOptions {
  wsDispatcher: WsJobDispatcher;
  serverApiKey: string;
}

const apiKeysMatch = (providedApiKey: string, expectedApiKey: string): boolean => {
  const providedDigest = createHash("sha256").update(providedApiKey).digest();
  const expectedDigest = createHash("sha256").update(expectedApiKey).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
};

const wsStatusLabel = (status: string): string => {
  const map: Record<string, string> = {
    QUEUED: "Chưa nhận dữ liệu",
    RUNNING: "Đang nhận dữ liệu",
    COMPLETED: "Hoàn thành",
    ERROR: "Lỗi",
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
    "/api/status",
    { preHandler: authenticateRequest },
    async (_request, reply) => {
      const workers = options.wsDispatcher.getConnectedWorkers();

      const workerStatuses = workers.map((w) => ({
        workerId: w.workerId,
        status: wsStatusLabel(w.status),
        lastDataSentAt: w.lastDataSentAt,
        lastDataReceivedAt: w.lastDataReceivedAt,
      }));

      return await reply.code(200).send({
        ok: true,
        workers: workerStatuses,
      });
    },
  );
};
