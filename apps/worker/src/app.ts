import { randomUUID } from "node:crypto";

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import { env, type WorkerEnv } from "./config/env.js";
import { WsClient, type WsClientLogger } from "./services/ws-client.js";

export interface BuildWorkerAppOptions {
  configuration?: WorkerEnv;
  logger?: FastifyServerOptions["logger"];
}

export const buildWorkerApp = async (
  options: BuildWorkerAppOptions = {},
): Promise<FastifyInstance> => {
  const configuration = options.configuration ?? env;
  const logger = options.logger ?? {
    level: configuration.NODE_ENV === "production" ? "info" : "debug",
    formatters: {
      level: (label: string) => ({ level: label }),
    },
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

  const wsLogger: WsClientLogger = {
    info: (context, message) => app.log.info(context, message),
    error: (context, message) => app.log.error(context, message),
  };

  const wsClient = new WsClient({
    serverBaseUrl: configuration.SERVER_BASE_URL,
    workerId: configuration.WORKER_ID,
    apiKey: configuration.SERVER_CALLBACK_API_KEY,
    heartbeatIntervalMs: configuration.HEARTBEAT_INTERVAL_MS,
    onData: async (data) => {
      app.log.info({ event: "DA_NHAN_DU_LIEU", rowsCount: data.rowsCount }, "Da nhan du lieu tu server");

      try {
        wsClient.reportDataReceived();
        app.log.info({ event: "DA_GUI_XAC_NHAN" }, "Da gui xac nhan du lieu ve server");
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        app.log.error({ event: "LOI_GUI_XAC_NHAN", error: msg }, "Gui xac nhan du lieu that bai");
        wsClient.reportDataFailed(msg);
      }
    },
    logger: wsLogger,
  });

  app.get("/health", async (_request, reply) =>
    await reply.code(200).send({
      ok: true,
      service: "pts-worker",
      workerId: configuration.WORKER_ID,
      wsConnected: wsClient.isConnected(),
      timestamp: new Date().toISOString(),
    }),
  );

  app.get("/api/status", async (_request, reply) =>
    await reply.code(200).send({
      ok: true,
      workerId: configuration.WORKER_ID,
      wsConnected: wsClient.isConnected(),
      timestamp: new Date().toISOString(),
    }),
  );

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
  });

  app.addHook("onListen", async () => {
    wsClient.start();
  });

  return app;
};
