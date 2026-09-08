import { z } from "zod";

const requiredText = (fieldName: string, maxLength: number) =>
  z
    .string({ error: `${fieldName} must be a string` })
    .trim()
    .min(1, `${fieldName} is required`)
    .max(maxLength, `${fieldName} must not exceed ${maxLength} characters`);

export const workerJobRequestSchema = z
  .object({
    jobId: requiredText("jobId", 100),
    createdAt: z.string().datetime({ offset: true }),
    request: z
      .object({
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
        itemCode: requiredText("itemCode", 100),
        action: requiredText("action", 100),
        path: requiredText("path", 500),
        productType: requiredText("productType", 100),
        layerNameList: requiredText("layerNameList", 500),
        replacements: z.string().trim().max(500).optional().default(""),
        outputPath: z.string().trim().max(500).optional().default(""),
        outputExt: z.string().trim().max(50).optional().default("jpg"),
        mockupPath: z.string().trim().max(500).optional().default(""),
        imageQuantity: z.string().trim().max(50).optional().default(""),
        data: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
  })
  .strict();

export const workerAcknowledgementSchema = z
  .object({
    ok: z.literal(true),
    accepted: z.literal(true),
    workerId: requiredText("workerId", 100),
    jobId: requiredText("jobId", 100),
    status: z.enum(["ACCEPTED", "PROCESSING"]),
  })
  .strict();

export const workerRuntimeStatusSchema = z.enum([
  "STARTING",
  "IDLE",
  "BUSY",
  "ERROR",
]);

export type WorkerJobRequest = z.infer<typeof workerJobRequestSchema>;
export type WorkerAcknowledgement = z.infer<
  typeof workerAcknowledgementSchema
>;
export type WorkerRuntimeStatus = z.infer<typeof workerRuntimeStatusSchema>;
