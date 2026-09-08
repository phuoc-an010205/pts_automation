import dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({ path: resolve("apps/server/.env") });

const SERVER_URL = `http://localhost:${process.env.SERVER_PORT ?? 8888}`;
const API_KEY = process.env.SERVER_API_KEY;

const testJobs = [
  {
    idempotencyKey: "n8n-sheet-row-1",
    orderNumber: "PYW30166",
    lineItemId: "KN0709260111",
    sku: "can-cooler-tumbler",
    productType: "Can Cooler Tumbler",
    data: {
      action: "edit text",
      outputPath:
        "H:\\Shared drives\\DESIGNS FULFILL\\designfulfill\\PYW30166_KN0709260111_can-cooler-tumbler\\can-cooler-tumbler",
      layer: "text",
      format: "jpg",
      fulfillPath:
        "H:\\.shortcut-targets-by-id\\13EtClCWA_cx1YzC5f_Q-Jh2WuD1kh4oB\\SELLERS\\TB02\\TB02-28082401\\TB02-28082401__tumbler.psd",
    },
  },
  {
    idempotencyKey: "n8n-sheet-row-2",
    orderNumber: "PYW30166",
    lineItemId: "KN0709260111",
    sku: "can-cooler-tumbler",
    productType: "Can Cooler Tumbler",
    data: {
      action: "save as",
      outputPath:
        "H:\\Shared drives\\DESIGNS FULFILL\\designfulfill\\PYW30166_KN0709260111_can-cooler-tumbler\\can-cooler-tumbler",
      layer: "jpg",
      format: "jpg",
    },
  },
];

const sendJob = async (job: (typeof testJobs)[0]): Promise<void> => {
  console.log(`\nSending job: ${job.idempotencyKey}`);

  const response = await fetch(`${SERVER_URL}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY!,
    },
    body: JSON.stringify(job),
  });

  const data = await response.json();
  console.log(`Response (${response.status}):`, JSON.stringify(data, null, 2));
};

const main = async (): Promise<void> => {
  console.log("=== n8n Test Script ===");
  console.log(`Server: ${SERVER_URL}`);

  for (const job of testJobs) {
    await sendJob(job);
  }

  console.log("\n=== Done ===");
};

void main();
