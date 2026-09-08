import type { FastifyInstance } from "fastify";

let workerApp: FastifyInstance | null = null;
let isShuttingDown = false;

const reportFatalError = (message: string, error: unknown): void => {
  const normalizedError =
    error instanceof Error ? error : new Error(String(error));

  if (workerApp) {
    workerApp.log.fatal({ err: normalizedError }, message);
    return;
  }

  console.error(message, normalizedError);
};

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  if (!workerApp) {
    process.exitCode = 0;
    return;
  }

  workerApp.log.info({ signal }, "Worker shutdown requested");

  try {
    await workerApp.close();
    workerApp.log.info("Worker shutdown completed");
    process.exitCode = 0;
  } catch (error: unknown) {
    reportFatalError("Worker shutdown failed", error);
    process.exitCode = 1;
  }
};

const startWorker = async (): Promise<void> => {
  try {
    const { env } = await import("./config/env.js");
    const { buildWorkerApp } = await import("./app.js");

    workerApp = await buildWorkerApp({ configuration: env });

    if (isShuttingDown) {
      await workerApp.close();
      return;
    }

    await workerApp.listen({
      host: env.WORKER_HOST,
      port: env.WORKER_PORT,
    });

    workerApp.log.info(
      {
        host: env.WORKER_HOST,
        port: env.WORKER_PORT,
        workerId: env.WORKER_ID,
      },
      "PTS Worker is ready",
    );
  } catch (error: unknown) {
    reportFatalError("PTS Worker failed to start", error);

    if (workerApp) {
      try {
        await workerApp.close();
      } catch (closeError: unknown) {
        reportFatalError("PTS Worker cleanup failed", closeError);
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

void startWorker();
