import type {
  RegisterWorkerRequest,
  RuntimeWorker,
  WorkerHeartbeatRequest,
} from "../domain/worker.js";

export type WorkerRegistryErrorCode =
  | "WORKER_NOT_REGISTERED"
  | "INVALID_HEARTBEAT"
  | "WORKER_NOT_RESERVED"
  | "WORKER_JOB_MISMATCH";

export interface WorkerRegistrationResult {
  worker: RuntimeWorker;
  interruptedJobId: string | null;
}

export class WorkerRegistryError extends Error {
  public readonly code: WorkerRegistryErrorCode;

  public constructor(code: WorkerRegistryErrorCode, message: string) {
    super(message);
    this.name = "WorkerRegistryError";
    this.code = code;
  }
}

export class WorkerRegistry {
  private readonly offlineTimeoutMs: number;
  private readonly workers = new Map<string, RuntimeWorker>();

  public constructor(offlineTimeoutMs: number) {
    if (!Number.isInteger(offlineTimeoutMs) || offlineTimeoutMs < 5_000) {
      throw new Error("offlineTimeoutMs must be an integer of at least 5000ms");
    }

    this.offlineTimeoutMs = offlineTimeoutMs;
  }

  public registerWorker(
    request: RegisterWorkerRequest,
  ): WorkerRegistrationResult {
    const existingWorker = this.workers.get(request.workerId);
    const timestamp = new Date().toISOString();
    const worker: RuntimeWorker = {
      id: request.workerId,
      advertisedUrl: request.advertisedUrl,
      hostname: request.hostname ?? existingWorker?.hostname ?? null,
      version: request.version,
      status: "STARTING",
      currentJobId: null,
      photoshopStatus: "NOT_RUNNING",
      registeredAt: existingWorker?.registeredAt ?? timestamp,
      lastSeen: timestamp,
    };

    this.workers.set(worker.id, worker);

    return {
      worker: structuredClone(worker),
      interruptedJobId: existingWorker?.currentJobId ?? null,
    };
  }

  public recordHeartbeat(request: WorkerHeartbeatRequest): RuntimeWorker {
    const currentWorker = this.requireWorker(request.workerId);
    this.validateHeartbeat(currentWorker, request);

    const preserveReservation =
      currentWorker.status === "RESERVED" && request.status === "IDLE";
    const worker: RuntimeWorker = {
      ...currentWorker,
      status: preserveReservation ? "RESERVED" : request.status,
      currentJobId: preserveReservation
        ? currentWorker.currentJobId
        : request.currentJobId,
      photoshopStatus: request.photoshopStatus,
      lastSeen: new Date().toISOString(),
    };

    this.workers.set(worker.id, worker);
    return structuredClone(worker);
  }

  public reserveIdleWorker(jobId: string): RuntimeWorker | null {
    for (const worker of this.workers.values()) {
      if (
        worker.status !== "IDLE" ||
        worker.currentJobId !== null ||
        worker.photoshopStatus !== "READY"
      ) {
        continue;
      }

      const reservedWorker: RuntimeWorker = {
        ...worker,
        status: "RESERVED",
        currentJobId: jobId,
      };
      this.workers.set(worker.id, reservedWorker);
      return structuredClone(reservedWorker);
    }

    return null;
  }

  public markWorkerBusy(workerId: string, jobId: string): RuntimeWorker {
    const worker = this.requireWorker(workerId);

    if (worker.status !== "RESERVED") {
      throw new WorkerRegistryError(
        "WORKER_NOT_RESERVED",
        `Worker ${workerId} is not reserved`,
      );
    }

    this.assertWorkerJob(worker, jobId);

    const busyWorker: RuntimeWorker = {
      ...worker,
      status: "BUSY",
      currentJobId: jobId,
    };
    this.workers.set(workerId, busyWorker);
    return structuredClone(busyWorker);
  }

  public releaseWorker(workerId: string, jobId: string): RuntimeWorker {
    const worker = this.requireWorker(workerId);
    this.assertWorkerJob(worker, jobId);

    const idleWorker: RuntimeWorker = {
      ...worker,
      status: "IDLE",
      currentJobId: null,
      photoshopStatus:
        worker.photoshopStatus === "RUNNING" ? "READY" : worker.photoshopStatus,
    };
    this.workers.set(workerId, idleWorker);
    return structuredClone(idleWorker);
  }

  public markOfflineWorkers(now = new Date()): RuntimeWorker[] {
    const offlineWorkers: RuntimeWorker[] = [];
    const currentTime = now.getTime();

    for (const worker of this.workers.values()) {
      if (worker.status === "OFFLINE") {
        continue;
      }

      const lastSeenTime = Date.parse(worker.lastSeen);

      if (
        Number.isNaN(lastSeenTime) ||
        currentTime - lastSeenTime <= this.offlineTimeoutMs
      ) {
        continue;
      }

      const offlineWorker: RuntimeWorker = {
        ...worker,
        status: "OFFLINE",
      };
      this.workers.set(worker.id, offlineWorker);
      offlineWorkers.push(structuredClone(offlineWorker));
    }

    return offlineWorkers;
  }

  public getWorker(workerId: string): RuntimeWorker | null {
    const worker = this.workers.get(workerId);
    return worker ? structuredClone(worker) : null;
  }

  public listWorkers(): RuntimeWorker[] {
    return Array.from(this.workers.values(), (worker) =>
      structuredClone(worker),
    ).sort((left, right) => left.id.localeCompare(right.id));
  }

  private requireWorker(workerId: string): RuntimeWorker {
    const worker = this.workers.get(workerId);

    if (!worker) {
      throw new WorkerRegistryError(
        "WORKER_NOT_REGISTERED",
        `Worker ${workerId} is not registered`,
      );
    }

    return worker;
  }

  private validateHeartbeat(
    currentWorker: RuntimeWorker,
    heartbeat: WorkerHeartbeatRequest,
  ): void {
    if (
      (heartbeat.status === "IDLE" || heartbeat.status === "STARTING") &&
      heartbeat.currentJobId !== null
    ) {
      throw new WorkerRegistryError(
        "INVALID_HEARTBEAT",
        `${heartbeat.status} worker ${heartbeat.workerId} cannot report a current job`,
      );
    }

    if (heartbeat.status === "BUSY" && heartbeat.currentJobId === null) {
      throw new WorkerRegistryError(
        "INVALID_HEARTBEAT",
        `BUSY worker ${heartbeat.workerId} must report its current job`,
      );
    }

    if (
      currentWorker.currentJobId !== null &&
      heartbeat.currentJobId !== null &&
      currentWorker.currentJobId !== heartbeat.currentJobId
    ) {
      throw new WorkerRegistryError(
        "WORKER_JOB_MISMATCH",
        `Worker ${heartbeat.workerId} reported an unexpected job`,
      );
    }
  }

  private assertWorkerJob(worker: RuntimeWorker, jobId: string): void {
    if (worker.currentJobId !== jobId) {
      throw new WorkerRegistryError(
        "WORKER_JOB_MISMATCH",
        `Worker ${worker.id} is not assigned to job ${jobId}`,
      );
    }
  }
}
