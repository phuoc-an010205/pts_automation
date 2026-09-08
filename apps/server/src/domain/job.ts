import { z } from "zod";

const requiredText = (fieldName: string, maxLength: number) =>
  z
    .string({ error: `${fieldName} must be a string` })
    .trim()
    .min(1, `${fieldName} is required`)
    .max(maxLength, `${fieldName} must not exceed ${maxLength} characters`);

export const jobStatusSchema = z.enum([
  "QUEUED",
  "ASSIGNED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
]);

export const createJobRequestSchema = z
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
  .strict();

export const workerJobRequestSchema = z
  .object({
    jobId: requiredText("jobId", 100),
    createdAt: z.string().datetime({ offset: true }),
    request: createJobRequestSchema,
  })
  .strict();

export type JobStatus = z.infer<typeof jobStatusSchema>;
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;
export type WorkerJobRequest = z.infer<typeof workerJobRequestSchema>;

export interface RuntimeJob {
  id: string;
  status: JobStatus;
  request: CreateJobRequest;
  assignedWorkerId: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}
