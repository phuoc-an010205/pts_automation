import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { GoogleSheetsService } from "./apps/server/src/services/google-sheets.js";

const main = async (): Promise<void> => {
  const saPath = resolve("service-account.json");
  const saContent = await readFile(saPath, "utf-8");
  const sa = JSON.parse(saContent);

  const service = new GoogleSheetsService({
    serviceAccountEmail: sa.client_email,
    privateKey: sa.private_key,
    spreadsheetId: "1O3S26f84qsZEidq2YAu0tSO7QGJSWM7cPbfZmbc1RKw",
  });

  try {
    const data = await service.readRange("A1:Z10");
    console.log("Sheet data:");
    console.table(data);
  } catch (error) {
    console.error("Error reading sheet:", error);
  }
};

void main();
