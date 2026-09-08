import { z } from "zod";

const requiredText = (fieldName: string, maxLength: number) =>
  z
    .string({ error: `${fieldName} must be a string` })
    .trim()
    .min(1, `${fieldName} is required`)
    .max(maxLength, `${fieldName} must not exceed ${maxLength} characters`);

export const jobResultParamsSchema = z
  .object({
    jobId: requiredText("jobId", 100),
  })
  .strict();

export const completedJobRequestSchema = z
  .object({
    workerId: requiredText("workerId", 100),
    result: z.record(z.string(), z.unknown()).default({}),
    outputFiles: z
      .array(requiredText("outputFile", 4_096))
      .max(1_000)
      .default([]),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const failedJobRequestSchema = z
  .object({
    workerId: requiredText("workerId", 100),
    errorCode: requiredText("errorCode", 100).regex(
      /^[A-Z][A-Z0-9_]*$/,
      "errorCode must use uppercase letters, numbers, and underscores",
    ),
    error: requiredText("error", 5_000),
  })
  .strict();

export type CompletedJobRequest = z.infer<
  typeof completedJobRequestSchema
>;
export type FailedJobRequest = z.infer<typeof failedJobRequestSchema>;

export type RuntimeJobResult =
  | {
      status: "COMPLETED";
      workerId: string;
      completedAt: string;
      result: Record<string, unknown>;
      outputFiles: string[];
    }
  | {
      status: "FAILED";
      workerId: string;
      failedAt: string;
      errorCode: string;
      error: string;
    };
