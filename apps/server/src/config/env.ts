import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { z } from "zod";

const envFilePath = new URL("../../.env", import.meta.url);

if (existsSync(envFilePath)) {
  loadEnvFile(envFilePath);
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SERVER_HOST: z.string().trim().min(1).default("0.0.0.0"),
  SERVER_PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  SERVER_API_KEY: z.string().min(16),
  SERVER_CALLBACK_API_KEY: z.string().min(16),
  WORKER_BASE_URL: z
    .string()
    .trim()
    .url()
    .refine(
      (value) => {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      },
      {
        message: "WORKER_BASE_URL must use the http or https protocol",
      },
    )
    .transform((value) => value.replace(/\/$/, "")),
  WORKER_API_KEY: z.string().min(16),
  WORKER_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5_000),
  WORKER_OFFLINE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(600_000)
    .default(30_000),
  GOOGLE_SERVICE_ACCOUNT_PATH: z.string().min(1),
  GOOGLE_SPREADSHEET_ID: z.string().min(1),
  CSV_OUTPUT_DIR: z.string().min(1).default("data/csv"),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const validationErrors = parsedEnv.error.issues
    .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    .join("; ");

  throw new Error(`Invalid server environment configuration: ${validationErrors}`);
}

export type ServerEnv = z.infer<typeof envSchema>;

export const env: ServerEnv = Object.freeze(parsedEnv.data);
