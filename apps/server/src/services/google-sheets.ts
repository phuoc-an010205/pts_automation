import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { google, type sheets_v4 } from "googleapis";

export interface GoogleSheetsConfig {
  serviceAccountPath: string;
  spreadsheetId: string;
  csvOutputDir?: string;
}

interface ServiceAccountFile {
  client_email: string;
  private_key: string;
}

export class GoogleSheetsService {
  private sheets: sheets_v4.Sheets | null = null;
  private readonly spreadsheetId: string;
  private readonly serviceAccountPath: string;
  private readonly csvOutputDir: string;
  private initializationPromise: Promise<void> | null = null;

  public constructor(config: GoogleSheetsConfig) {
    this.spreadsheetId = config.spreadsheetId;
    this.serviceAccountPath = config.serviceAccountPath;
    this.csvOutputDir = config.csvOutputDir ?? "data/csv";
  }

  public async initialize(): Promise<void> {
    if (this.sheets) {
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.loadServiceAccount();
    await this.initializationPromise;
  }

  private async loadServiceAccount(): Promise<void> {
    const content = await readFile(this.serviceAccountPath, "utf-8");
    const sa: ServiceAccountFile = JSON.parse(content);

    const auth = new google.auth.JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    this.sheets = google.sheets({ version: "v4", auth });
  }

  private async ensureInitialized(): Promise<sheets_v4.Sheets> {
    await this.initialize();
    return this.sheets!;
  }

  public async readRange(range: string): Promise<unknown[][]> {
    const sheets = await this.ensureInitialized();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range,
    });

    return response.data.values ?? [];
  }

  public async appendRow(
    range: string,
    values: unknown[],
  ): Promise<sheets_v4.Schema$AppendValuesResponse> {
    const sheets = await this.ensureInitialized();
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [values],
      },
    });

    return response.data;
  }

  public async updateRow(
    range: string,
    values: unknown[],
  ): Promise<sheets_v4.Schema$UpdateValuesResponse> {
    const sheets = await this.ensureInitialized();
    const response = await sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [values],
      },
    });

    return response.data;
  }

  public async getSheetId(sheetName: string): Promise<number | null> {
    const sheets = await this.ensureInitialized();
    const response = await sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: "sheets.properties",
    });

    const sheet = response.data.sheets?.find(
      (s) => s.properties?.title === sheetName,
    );

    return sheet?.properties?.sheetId ?? null;
  }

  public async createCsvFromSheet(
    range: string,
    filename: string,
  ): Promise<string> {
    const data = await this.readRange(range);

    if (data.length === 0) {
      throw new Error(`No data found in range: ${range}`);
    }

    await mkdir(this.csvOutputDir, { recursive: true });

    const csvContent = data
      .map((row) =>
        row
          .map((cell) => {
            const str = String(cell ?? "");
            if (str.includes(",") || str.includes('"') || str.includes("\n")) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          })
          .join(","),
      )
      .join("\n");

    const csvPath = join(this.csvOutputDir, filename);
    await writeFile(csvPath, csvContent, "utf-8");

    return csvPath;
  }
}
