import type { FastifyInstance } from "fastify";

let server: FastifyInstance | null = null;
let isShuttingDown = false;

const reportFatalError = (message: string, error: unknown): void => {
  const normalizedError =
    error instanceof Error ? error : new Error(String(error));

  if (server) {
    server.log.fatal({ err: normalizedError }, message);
    return;
  }

  console.error(message, normalizedError);
};

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  if (!server) {
    process.exitCode = 0;
    return;
  }

  server.log.info({ signal }, "Server shutdown requested");

  try {
    await server.close();
    server.log.info("Server shutdown completed");
    process.exitCode = 0;
  } catch (error: unknown) {
    reportFatalError("Server shutdown failed", error);
    process.exitCode = 1;
  }
};

const startServer = async (): Promise<void> => {
  try {
    const { env } = await import("./config/env.js");
    const { buildApp } = await import("./app.js");

    server = await buildApp({ configuration: env });

    if (isShuttingDown) {
      await server.close();
      return;
    }

    await server.listen({
      host: env.SERVER_HOST,
      port: env.SERVER_PORT,
    });

    server.log.info(
      {
        host: env.SERVER_HOST,
        port: env.SERVER_PORT,
      },
      "PTS Server is ready",
    );
  } catch (error: unknown) {
    reportFatalError("PTS Server failed to start", error);

    if (server) {
      try {
        await server.close();
      } catch (closeError: unknown) {
        reportFatalError("PTS Server cleanup failed", closeError);
      }
    }

    process.exitCode = 1;
  }
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

void startServer();
