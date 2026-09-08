import { z } from "zod";

const requiredText = (fieldName: string, maxLength: number) =>
  z
    .string({ error: `${fieldName} must be a string` })
    .trim()
    .min(1, `${fieldName} is required`)
    .max(maxLength, `${fieldName} must not exceed ${maxLength} characters`);

const advertisedUrlSchema = z
  .string()
  .trim()
  .url()
  .refine(
    (value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    },
    {
      message: "advertisedUrl must use the http or https protocol",
    },
  )
  .transform((value) => value.replace(/\/$/, ""));

export const workerReportedStatusSchema = z.enum([
  "STARTING",
  "IDLE",
  "BUSY",
  "ERROR",
]);

export const serverWorkerStatusSchema = z.enum([
  "STARTING",
  "IDLE",
  "RESERVED",
  "BUSY",
  "ERROR",
  "OFFLINE",
]);

export const photoshopStatusSchema = z.enum([
  "NOT_RUNNING",
  "STARTING",
  "READY",
  "RUNNING",
  "ERROR",
]);

export const registerWorkerRequestSchema = z
  .object({
    workerId: requiredText("workerId", 100).regex(
      /^[A-Za-z0-9._-]+$/,
      "workerId contains unsupported characters",
    ),
    advertisedUrl: advertisedUrlSchema,
    hostname: requiredText("hostname", 255).optional(),
    version: requiredText("version", 50),
  })
  .strict();

export const workerHeartbeatRequestSchema = z
  .object({
    workerId: requiredText("workerId", 100),
    status: workerReportedStatusSchema,
    currentJobId: requiredText("currentJobId", 100).nullable(),
    photoshopStatus: photoshopStatusSchema,
  })
  .strict();

export type WorkerReportedStatus = z.infer<
  typeof workerReportedStatusSchema
>;
export type ServerWorkerStatus = z.infer<typeof serverWorkerStatusSchema>;
export type PhotoshopStatus = z.infer<typeof photoshopStatusSchema>;
export type RegisterWorkerRequest = z.infer<
  typeof registerWorkerRequestSchema
>;
export type WorkerHeartbeatRequest = z.infer<
  typeof workerHeartbeatRequestSchema
>;

export interface RuntimeWorker {
  id: string;
  advertisedUrl: string;
  hostname: string | null;
  version: string;
  status: ServerWorkerStatus;
  currentJobId: string | null;
  photoshopStatus: PhotoshopStatus;
  registeredAt: string;
  lastSeen: string;
}
