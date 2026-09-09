import { execFile } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  PhotoshopController,
  PhotoshopControllerStatus,
  PhotoshopExecutionResult,
  PhotoshopStatus,
} from "./photoshop-controller.js";
import { PhotoshopControllerError } from "./photoshop-controller.js";
import type { WorkerJobRequest } from "../domain/job.js";

const execFileAsync = promisify(execFile);

export interface WindowsPhotoshopControllerOptions {
  jsxTempDir?: string;
  jsxbinPath?: string;
  photoshopPath?: string;
  localCsvDir?: string;
}

export class WindowsPhotoshopController implements PhotoshopController {
  private status: PhotoshopStatus = "NOT_RUNNING";
  private lastError: string | null = null;
  private readonly jsxTempDir: string;
  private readonly jsxbinPath: string;
  private readonly photoshopPath: string;
  private readonly localCsvDir: string;

  public constructor(options?: WindowsPhotoshopControllerOptions) {
    this.jsxTempDir = options?.jsxTempDir ?? "C:\\Users\\3\\Desktop\\luutru";
    this.jsxbinPath =
      options?.jsxbinPath ?? "C:\\Users\\3\\Desktop\\psd_tool_v2\\psd_tool_v3.jsxbin";
    this.photoshopPath = options?.photoshopPath ?? "";
    this.localCsvDir = options?.localCsvDir ?? "C:\\Users\\3\\Desktop\\luutru";
  }

  public isRunning(): boolean {
    return this.status !== "NOT_RUNNING";
  }

  public isReady(): boolean {
    return this.status === "READY";
  }

  public async start(): Promise<void> {
    if (this.status === "READY" || this.status === "RUNNING") {
      return;
    }

    this.status = "STARTING";
    this.lastError = null;

    try {
      const isRunning = await this.checkPhotoshopRunning();
      if (!isRunning) {
        await this.launchPhotoshop();
      }
      this.status = "READY";
    } catch (error: unknown) {
      this.status = "ERROR";
      this.lastError = this.normalizeError(error);
      throw new PhotoshopControllerError(
        "Failed to start Windows Photoshop controller",
        { cause: error },
      );
    }
  }

  public async executeJob(
    job: WorkerJobRequest,
    signal?: AbortSignal,
  ): Promise<PhotoshopExecutionResult> {
    if (!this.isReady()) {
      throw new PhotoshopControllerError(
        `Photoshop controller is not ready; current status is ${this.status}`,
      );
    }

    this.status = "RUNNING";
    this.lastError = null;

    const jsonPath = join(this.jsxTempDir, `job-${job.jobId}.json`);
    const csvPath = join(this.localCsvDir, `job-${job.jobId}.csv`);

    try {
      const csvRows = job.request.data?.csvRows as string[][] | undefined;
      if (csvRows && csvRows.length > 0) {
        await mkdir(this.localCsvDir, { recursive: true });

        const header = [
          "item_code",
          "action",
          "path",
          "product_type",
          "layer_name_list",
          "replacements",
          "output path",
          "output ext",
          "mockup path",
          "image quantity",
        ];

        const dataRows = csvRows.slice(1).map((row) => {
          const itemCode = row[0] ?? "";
          const action = row[1] ?? "";
          const path = row[2] ?? "";
          const productType = row[3] ?? "";
          const layerNameList = row[4] ?? "";
          const replacements = job.request.replacements ?? "";
          const outputPath = job.request.outputPath ?? "";
          const outputExt = job.request.outputExt ?? "jpg";
          const mockupPath = job.request.mockupPath ?? "";
          const imageQuantity = job.request.imageQuantity ?? "";
          return [itemCode, action, path, productType, layerNameList, replacements, outputPath, outputExt, mockupPath, `"${imageQuantity}"`];
        });

        const allRows = [header, ...dataRows];
        const csvContent = allRows
          .map((row) => row.join(","))
          .join("\n");
        await writeFile(csvPath, "\uFEFF" + csvContent, "utf-8");
      }

      const jobData = {
        jobId: job.jobId,
        timestamp: job.createdAt,
        itemCode: job.request.itemCode ?? "N/A",
        action: job.request.action ?? "N/A",
        path: job.request.path ?? "N/A",
        productType: job.request.productType ?? "N/A",
        layerNameList: job.request.layerNameList ?? "N/A",
        csvPath,
      };

      await writeFile(jsonPath, JSON.stringify(jobData, null, 2), "utf-8");
      console.log("====================================");
      console.log("Photoshop Job:", job.jobId);
      console.log("CSV:", csvPath);
      console.log("JSXBIN:", this.jsxbinPath);
      console.log("====================================");
      await this.runJsxbin(jsonPath, csvPath, signal);
      
      console.log("Photoshop Finished:", job.jobId);

      return {
        jobId: job.jobId,
        completedAt: new Date().toISOString(),
        outputFiles: [],
        details: {
          controller: "windows-com",
          jsxbinPath: this.jsxbinPath,
          jsonPath,
          csvPath,
        },
      };
    } catch (error: unknown) {
      this.lastError = this.normalizeError(error);
      throw new PhotoshopControllerError(
        `Photoshop execution failed for job ${job.jobId}`,
        { cause: error },
      );
    } finally {
      try {
        await unlink(jsonPath);
      } catch {
        // ignore cleanup errors
      }
      if (this.status === "RUNNING") {
        this.status = "READY";
      }
    }
  }

  public getStatus(): PhotoshopControllerStatus {
    return {
      status: this.status,
      lastError: this.lastError,
    };
  }

  public async stop(): Promise<void> {
    if (this.status === "RUNNING") {
      throw new PhotoshopControllerError(
        "Cannot stop Photoshop controller while a job is running",
      );
    }

    this.status = "NOT_RUNNING";
    this.lastError = null;
  }

  private async checkPhotoshopRunning(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        "Get-Process -Name Photoshop -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
      ]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async launchPhotoshop(): Promise<void> {
    const psPath = this.photoshopPath || (await this.findPhotoshop());

    if (!psPath) {
      throw new PhotoshopControllerError(
        "Photoshop not found. Set PHOTOSHOP_PATH in .env or install Photoshop.",
      );
    }

    await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      `Start-Process "${psPath}"`,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  private async findPhotoshop(): Promise<string | null> {
    const commonPaths = [
      "C:\\Program Files\\Adobe\\Adobe Photoshop 2025\\Photoshop.exe",
      "C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe",
      "C:\\Program Files\\Adobe\\Adobe Photoshop 2023\\Photoshop.exe",
      "C:\\Program Files\\Adobe\\Adobe Photoshop 2022\\Photoshop.exe",
    ];

    for (const path of commonPaths) {
      try {
        await execFileAsync("powershell", [
          "-NoProfile",
          "-Command",
          `Test-Path "${path}"`,
        ]);
        return path;
      } catch {
        continue;
      }
    }

    try {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe" -ErrorAction SilentlyContinue).'(default)'`,
      ]);
      const regPath = stdout.trim();
      if (regPath) {
        return regPath;
      }
    } catch {
      // ignore
    }

    return null;
  }

  private async runJsxbin(_jsonPath: string, csvPath: string, signal?: AbortSignal): Promise<void> {
  const escapedJsxbinPath = this.jsxbinPath.replace(/\\/g, "\\\\");
  const escapedCsvPath = csvPath.replace(/\\/g, "\\\\");

  const maxRetries = 5;

  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const script = `
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Write-Host "[1] Connect Photoshop COM"
$app = New-Object -ComObject Photoshop.Application
$app.Visible = $true

# Đưa Photoshop lên foreground
Start-Sleep -Milliseconds 1000
try {
    [Microsoft.VisualBasic.Interaction]::AppActivate("Adobe Photoshop") | Out-Null
} catch {}

Write-Host "[2] Launch JSXBIN"
$app.DoJavaScriptFile("${escapedJsxbinPath}")

# ==========================================
# CHỜ HỘP THOẠI OPEN FILE XUẤT HIỆN
# ==========================================
Write-Host "[3] Waiting Open Dialog..."

$root = [System.Windows.Automation.AutomationElement]::RootElement
$dialog = $null

for ($i = 0; $i -lt 30; $i++) {

    $windows = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Window
        ))
    )

    foreach ($w in $windows) {
        $name = $w.Current.Name

        if ($name -match "Open|Mở|File|Chọn") {
            $dialog = $w
            break
        }
    }

    if ($dialog) { break }

    Start-Sleep -Milliseconds 500
}

if (-not $dialog) {
    throw "Open dialog not found after waiting 15 seconds."
}

Write-Host "[4] Dialog Found: $($dialog.Current.Name)"

# ==========================================
# ACTIVATE DIALOG
# ==========================================
try {
    $dialog.SetFocus()
} catch {}

Start-Sleep -Milliseconds 500

# ==========================================
# COPY CSV PATH VÀO CLIPBOARD
# ==========================================
Write-Host "[5] Copy CSV Path"
[System.Windows.Forms.Clipboard]::SetText("${escapedCsvPath}")

Start-Sleep -Milliseconds 500

# ==========================================
# PASTE FILE PATH
# ==========================================
Write-Host "[6] Paste CSV"
[System.Windows.Forms.SendKeys]::SendWait("^v")

Start-Sleep -Milliseconds 500

# ==========================================
# ENTER ĐỂ OPEN FILE
# ==========================================
Write-Host "[7] Press ENTER"
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

Start-Sleep -Seconds 3

Write-Host "[8] CSV Imported"
`;

        const { stdout, stderr } = await execFileAsync(
          "powershell",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
          {
            timeout: 120000,
            signal,
            maxBuffer: 1024 * 1024 * 10,
          },
        );

        if (stdout) {
          console.log(stdout);
        }

        if (stderr) {
          console.error(stderr);
        }

        return;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        const isBusy = message.includes("RPC_E_SERVERCALL_RETRYLATER");

        if (isBusy && attempt < maxRetries) {
          console.warn(`Photoshop busy. Retry ${attempt}/${maxRetries}`);
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
          continue;
        }

        throw error;
      }
    }
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
} 

  private normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 1_000);
  }
}
