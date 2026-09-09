import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import fastifyWebsocket from "@fastify/websocket";

import { env, type ServerEnv } from "./config/env.js";
import { registerJobResultRoutes } from "./routes/job-results.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerSheetJobRoutes } from "./routes/sheet-jobs.js";
import { registerWorkerRoutes } from "./routes/workers.js";
import { registerWsWorkerRoutes } from "./routes/ws-workers.js";
import { GoogleSheetsService } from "./services/google-sheets.js";
import { JobService } from "./services/job-service.js";
import { WorkerRegistry } from "./services/worker-registry.js";
import { WsJobDispatcher } from "./services/ws-job-dispatcher.js";

export interface BuildAppOptions {
  configuration?: ServerEnv;
  workerRegistry?: WorkerRegistry;
  logger?: FastifyServerOptions["logger"];
}

export const buildApp = async (
  options: BuildAppOptions = {},
): Promise<FastifyInstance> => {
  const configuration = options.configuration ?? env;
  const logger = options.logger ?? {
    level: configuration.NODE_ENV === "production" ? "info" : "debug",
    redact: {
      paths: [
        "req.headers['x-api-key']",
        "req.headers.authorization",
        "request.headers['x-api-key']",
        "request.headers.authorization",
      ],
      censor: "[REDACTED]",
    },
  };
  const app = Fastify({
    logger,
    genReqId: () => randomUUID(),
    trustProxy: false,
    bodyLimit: 1_048_576,
  });

  await app.register(fastifyWebsocket);

  const jobService = new JobService();
  const workerRegistry =
    options.workerRegistry ??
    new WorkerRegistry(configuration.WORKER_OFFLINE_TIMEOUT_MS);
  const googleSheets = new GoogleSheetsService({
    serviceAccountPath: resolve(configuration.GOOGLE_SERVICE_ACCOUNT_PATH),
    spreadsheetId: configuration.GOOGLE_SPREADSHEET_ID,
    csvOutputDir: configuration.CSV_OUTPUT_DIR,
  });

  const wsLogger = {
    info: (ctx: Record<string, unknown>, msg: string) => app.log.info(ctx, msg),
    error: (ctx: Record<string, unknown>, msg: string) => app.log.error(ctx, msg),
  };
  const wsDispatcher = new WsJobDispatcher(wsLogger);

  jobService.setJobCreatedListener((job) => {
    wsDispatcher.notifyJobCreated(job);
  });

  app.get("/health", async (_request, reply) =>
    await reply.code(200).send({
      ok: true,
      service: "pts-server",
      status: "READY",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    }),
  );

  await registerJobRoutes(app, {
    jobService,
    serverApiKey: configuration.SERVER_API_KEY,
  });

  await registerWorkerRoutes(app, {
    workerRegistry,
    callbackApiKey: configuration.SERVER_CALLBACK_API_KEY,
    serverApiKey: configuration.SERVER_API_KEY,
  });

  await registerJobResultRoutes(app, {
    jobService,
    workerRegistry,
    callbackApiKey: configuration.SERVER_CALLBACK_API_KEY,
  });

  await registerSheetJobRoutes(app, {
    jobService,
    googleSheets,
    serverApiKey: configuration.SERVER_API_KEY,
  });

  await registerWsWorkerRoutes(app, {
    wsDispatcher,
    jobService,
    serverApiKey: configuration.SERVER_API_KEY,
  });

  app.get("/ws/worker", { websocket: true }, (socket, request) => {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const workerId = url.searchParams.get("workerId");

    if (!workerId) {
      socket.close(4001, "workerId query parameter is required");
      return;
    }

    const providedApiKey = url.searchParams.get("apiKey");
    if (providedApiKey !== configuration.SERVER_CALLBACK_API_KEY) {
      socket.close(4003, "Unauthorized");
      return;
    }

    wsDispatcher.handleConnection(socket, workerId);
  });

  app.setNotFoundHandler(async (_request, reply) =>
    await reply.code(404).send({
      ok: false,
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "The requested route does not exist",
      },
    }),
  );

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error(
      {
        err: error,
        requestId: request.id,
      },
      "Unhandled request error",
    );

    if (reply.sent) {
      return;
    }

    const receivedStatusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : null;
    const isClientError =
      typeof receivedStatusCode === "number" &&
      receivedStatusCode >= 400 &&
      receivedStatusCode < 500;
    const statusCode = isClientError ? receivedStatusCode : 500;

    await reply.code(statusCode).send({
      ok: false,
      error: {
        code: isClientError ? "INVALID_REQUEST" : "INTERNAL_SERVER_ERROR",
        message: isClientError
          ? "The request could not be processed"
          : "An unexpected server error occurred",
        details:
          configuration.NODE_ENV === "development"
            ? {
                name: error instanceof Error ? error.name : "UnknownError",
                message: error instanceof Error ? error.message : String(error),
              }
            : undefined,
      },
    });
  });

  return app;
};
