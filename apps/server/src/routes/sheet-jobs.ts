import { createHash, timingSafeEqual } from "node:crypto";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z, type ZodIssue } from "zod";

import { GoogleSheetsService } from "../services/google-sheets.js";
import type { WsJobDispatcher } from "../services/ws-job-dispatcher.js";

const apiKeyHeadersSchema = z
  .object({
    "x-api-key": z.string().min(1),
  })
  .passthrough();

export interface SheetJobRoutesOptions {
  wsDispatcher: WsJobDispatcher;
  googleSheets: GoogleSheetsService;
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

export const registerSheetJobRoutes = async (
  app: FastifyInstance,
  options: SheetJobRoutesOptions,
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

  const sendDataSchema = z
    .object({
      workerId: z.string().trim().min(1).max(100),
      sheetRange: z.string().trim().min(1).max(200),
      itemCode: z.string().trim().min(1).max(100).optional(),
      action: z.string().trim().min(1).max(100).optional(),
      path: z.string().trim().min(1).max(500).optional(),
      productType: z.string().trim().min(1).max(100).optional(),
      layerNameList: z.string().trim().min(1).max(500).optional(),
      replacements: z.string().trim().max(500).optional().default(""),
      outputPath: z.string().trim().max(500).optional().default(""),
      outputExt: z.string().trim().max(50).optional().default("jpg"),
      mockupPath: z.string().trim().max(500).optional().default(""),
      imageQuantity: z.string().trim().max(50).optional().default(""),
    })
    .strict();

  app.post(
    "/api/send-data",
    { preHandler: authenticateRequest },
    async (request, reply) => {
      const parsedRequest = sendDataSchema.safeParse(request.body);

      if (!parsedRequest.success) {
        return await reply.code(400).send({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The request is invalid",
            details: formatValidationIssues(parsedRequest.error.issues),
          },
        });
      }

      const { workerId, sheetRange, ...meta } = parsedRequest.data;

      if (!options.wsDispatcher.isWorkerConnected(workerId)) {
        return await reply.code(404).send({
          ok: false,
          error: {
            code: "WORKER_NOT_CONNECTED",
            message: `Worker ${workerId} is not connected via WebSocket`,
          },
        });
      }

      try {
        const data = await options.googleSheets.readRange(sheetRange);

        if (data.length === 0) {
          return await reply.code(400).send({
            ok: false,
            error: {
              code: "EMPTY_SHEET",
              message: "No data found in the specified range",
            },
          });
        }

        const sent = options.wsDispatcher.sendDataToWorker(workerId, {
          ...meta,
          sheetRange,
          csvRows: data,
          rowsCount: data.length,
        });

        if (!sent) {
          return await reply.code(500).send({
            ok: false,
            error: {
              code: "DISPATCH_FAILED",
              message: "Failed to send data to worker",
            },
          });
        }

        return await reply.code(202).send({
          ok: true,
          workerId,
          rowsCount: data.length,
          message: "Data dispatched to worker",
        });
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown error";

        return await reply.code(500).send({
          ok: false,
          error: {
            code: "SHEET_READ_ERROR",
            message: `Failed to read sheet: ${message}`,
          },
        });
      }
    },
  );
};
