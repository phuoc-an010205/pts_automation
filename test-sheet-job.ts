import dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({ path: resolve("apps/server/.env") });

const SERVER_URL = `http://localhost:${process.env.SERVER_PORT ?? 8888}`;
const API_KEY = process.env.SERVER_API_KEY;

const testSheetJob = {
  idempotencyKey: `sheet-test-${Date.now()}`,
  orderNumber: "PYW30166",
  lineItemId: "KN0709260111",
  sku: "can-cooler-tumbler",
  productType: "Can Cooler Tumbler",
  sheetRange: "A1:E10",
};

const main = async (): Promise<void> => {
  console.log("=== Test: Create job from Google Sheet ===\n");
  console.log(`Server: ${SERVER_URL}`);
  console.log(`Sheet Range: ${testSheetJob.sheetRange}\n`);

  const response = await fetch(`${SERVER_URL}/api/jobs-from-sheet`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY!,
    },
    body: JSON.stringify(testSheetJob),
  });

  const data = await response.json();
  console.log(`Response (${response.status}):`);
  console.log(JSON.stringify(data, null, 2));
};

void main();
