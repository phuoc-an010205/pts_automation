import { randomUUID } from "node:crypto";

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import {
  MockPhotoshopController,
  type PhotoshopController,
} from "./controllers/photoshop-controller.js";
import { WindowsPhotoshopController } from "./controllers/windows-photoshop-controller.js";
import { env, type WorkerEnv } from "./config/env.js";
import { registerWorkerRoutes } from "./routes/worker.js";
import {
  JobProcessor,
  type JobProcessorLogger,
} from "./services/job-processor.js";
import { ResultReporter } from "./services/result-reporter.js";
import { ServerClient } from "./services/server-client.js";
import { WorkerState } from "./services/worker-state.js";
import { WsClient, type WsClientLogger } from "./services/ws-client.js";

export interface BuildWorkerAppOptions {
  configuration?: WorkerEnv;
  controller?: PhotoshopController;
  serverClient?: ServerClient;
  logger?: FastifyServerOptions["logger"];
}

export const buildWorkerApp = async (
  options: BuildWorkerAppOptions = {},
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
  const serviceLogger: JobProcessorLogger = {
    info: (context, message) => app.log.info(context, message),
    error: (context, message) => app.log.error(context, message),
  };
  const serverClient =
    options.serverClient ??
    new ServerClient({
      baseUrl: configuration.SERVER_BASE_URL,
      apiKey: configuration.SERVER_CALLBACK_API_KEY,
      timeoutMs: configuration.SERVER_REQUEST_TIMEOUT_MS,
    });
  const workerState = new WorkerState(configuration.WORKER_ID);
  const photoshopController =
    options.controller ??
    (configuration.USE_MOCK_PHOTOSHOP
      ? new MockPhotoshopController(configuration.MOCK_PROCESSING_TIME_MS)
      : new WindowsPhotoshopController({
          photoshopPath: configuration.PHOTOSHOP_PATH,
        }));

  const wsLogger: WsClientLogger = {
    info: (context, message) => app.log.info(context, message),
    error: (context, message) => app.log.error(context, message),
  };

  const wsClient = new WsClient({
    serverBaseUrl: configuration.SERVER_BASE_URL,
    workerId: configuration.WORKER_ID,
    apiKey: configuration.SERVER_CALLBACK_API_KEY,
    heartbeatIntervalMs: configuration.HEARTBEAT_INTERVAL_MS,
    onJob: async (job) => {
      const claim = jobProcessor.submitJob(job);

      if (claim.kind === "CLAIMED") {
        app.log.info({ jobId: job.jobId }, "Job claimed via WebSocket");
      }
    },
    getStatus: () => {
      const state = jobProcessor.getState();
      const psStatus = jobProcessor.getControllerStatus();
      return {
        status: state.status,
        photoshopStatus: psStatus.status,
        currentJobId: state.currentJobId,
      };
    },
    logger: wsLogger,
  });

  const resultReporter = new ResultReporter({
    serverClient,
    wsClient,
    retryIntervalMs: configuration.HEARTBEAT_INTERVAL_MS,
    logger: serviceLogger,
  });

  const jobProcessor = new JobProcessor(
    workerState,
    photoshopController,
    resultReporter,
    serviceLogger,
  );

  await jobProcessor.initialize();

  await registerWorkerRoutes(app, {
    workerId: configuration.WORKER_ID,
    workerApiKey: configuration.WORKER_API_KEY,
    jobProcessor,
    workerCoordinator: null,
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
      "Unhandled worker request error",
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
        code: isClientError ? "INVALID_REQUEST" : "INTERNAL_WORKER_ERROR",
        message: isClientError
          ? "The request could not be processed"
          : "An unexpected worker error occurred",
      },
    });
  });

  app.addHook("onClose", async () => {
    wsClient.stop();
    await jobProcessor.shutdown();
    await resultReporter.shutdown();
  });

  app.addHook("onListen", async () => {
    wsClient.start();
  });

  return app;
};
