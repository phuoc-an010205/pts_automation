import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";

import { z } from "zod";

const envFilePath = new URL("../../.env", import.meta.url);
const envFileCwd = resolve(process.cwd(), ".env");

if (existsSync(envFilePath)) {
  loadEnvFile(envFilePath);
} else if (existsSync(envFileCwd)) {
  loadEnvFile(envFileCwd);
}

const httpUrlSchema = (fieldName: string) =>
  z
    .string()
    .trim()
    .url()
    .refine(
      (value) => {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      },
      {
        message: `${fieldName} must use the http or https protocol`,
      },
    )
    .transform((value) => value.replace(/\/$/, ""));

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  WORKER_ID: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(
      /^[A-Za-z0-9._-]+$/,
      "WORKER_ID may only contain letters, numbers, dots, underscores, and hyphens",
    ),
  WORKER_HOST: z.string().trim().min(1).default("0.0.0.0"),
  WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(8_787),
  WORKER_API_KEY: z.string().min(16),
  WORKER_ADVERTISED_URL: httpUrlSchema("WORKER_ADVERTISED_URL"),
  MOCK_PROCESSING_TIME_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(5_000),
  SERVER_BASE_URL: httpUrlSchema("SERVER_BASE_URL"),
  SERVER_CALLBACK_API_KEY: z.string().min(16),
  SERVER_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5_000),
  HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .default(5_000),
  USE_MOCK_PHOTOSHOP: z
    .preprocess(
      (val) => val === "true" || val === "1",
      z.boolean().default(true),
    ),
  JOB_POLLER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(30_000)
    .default(3_000),
  PHOTOSHOP_PATH: z.string().trim().default(""),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const validationErrors = parsedEnv.error.issues
    .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    .join("; ");

  throw new Error(`Invalid worker environment configuration: ${validationErrors}`);
}

export type WorkerEnv = z.infer<typeof envSchema>;

export const env: WorkerEnv = Object.freeze(parsedEnv.data);
