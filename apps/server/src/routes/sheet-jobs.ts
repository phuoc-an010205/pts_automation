import { createHash, timingSafeEqual } from "node:crypto";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z, type ZodIssue } from "zod";

import { GoogleSheetsService } from "../services/google-sheets.js";
import { JobService } from "../services/job-service.js";

const apiKeyHeadersSchema = z
  .object({
    "x-api-key": z.string().min(1),
  })
  .passthrough();

export interface SheetJobRoutesOptions {
  jobService: JobService;
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

  const createSheetJobSchema = z
    .object({
      idempotencyKey: z.string().trim().min(1).max(200).optional(),
      itemCode: z.string().trim().min(1).max(100),
      action: z.string().trim().min(1).max(100),
      path: z.string().trim().min(1).max(500),
      productType: z.string().trim().min(1).max(100),
      layerNameList: z.string().trim().min(1).max(500),
      replacements: z.string().trim().max(500).optional().default(""),
      outputPath: z.string().trim().max(500).optional().default(""),
      outputExt: z.string().trim().max(50).optional().default("jpg"),
      mockupPath: z.string().trim().max(500).optional().default(""),
      imageQuantity: z.string().trim().max(50).optional().default(""),
      sheetRange: z.string().trim().min(1).max(200),
    })
    .strict();

  app.post(
    "/api/jobs-from-sheet",
    { preHandler: authenticateRequest },
    async (request, reply) => {
      const parsedRequest = createSheetJobSchema.safeParse(request.body);

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

      const { sheetRange, ...jobData } = parsedRequest.data;

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

        const result = await options.jobService.submitJob({
          ...jobData,
          data: {
            sheetRange,
            csvRows: data,
          },
        });

        return await reply.code(202).send({
          ok: true,
          jobId: result.job.id,
          status: result.job.status,
          rowsCount: data.length,
        });
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown error";

        return await reply.code(500).send({
          ok: false,
          error: {
            code: "SHEET_READ_ERROR",
            message: `Failed to read sheet or create CSV: ${message}`,
          },
        });
      }
    },
  );
};
