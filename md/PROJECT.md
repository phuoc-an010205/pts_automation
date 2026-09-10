# PTS Automation - Ghi chú

## Kiến trúc tổng quan

```
n8n (Schedule Trigger) → Server (192.168.10.112:8888) → Worker/PC44 (192.168.10.144:8787)
         ↓                                              ↓
    Đọc Google Sheet mỗi X giây               Nhận data, xác nhận
    Có data mới → POST                        (qua WebSocket)
    Không có → bỏ qua
```

## Machines

| Machine | IP | Vai trò |
|---------|-----|---------|
| PC-parttime | 192.168.10.112 | Server (Fastify + WebSocket) |
| PC44 | 192.168.10.144 | Worker (nhận data, xác nhận) |

## API Keys

- Server API Key: `andepzai01022005`
- Server Callback API Key: `andepzai01022005`
- Worker API Key: `andepzai01022005`

## Google Sheet

- Spreadsheet ID: `1O3S26f84qsZEidq2YAu0tSO7QGJSWM7cPbfZmbc1RKw`
- Service Account: `service-account.json` (gitignored)
- CSV columns: `item_code, action, path, product_type, layer_name_list, replacements, output path, output ext, mockup path, image quantity`

## Flow hiện tại

1. n8n Schedule Trigger poll Google Sheet mỗi 30 giây
2. So sánh data với lần trước (MD5 hash)
3. Có data mới → POST `/api/send-data` đến server
4. Server đọc Google Sheet bằng service account
5. Server push data đến PC44 qua WebSocket
6. PC44 nhận data → xác nhận (`DATA_RECEIVED`)
7. PC44 giữ status "Đang nhận dữ liệu"

## n8n Workflows

### DataPTS-Auto (Schedule Trigger + Set Mốc Khởi Điểm)

Workflow có 2 chi nhánh:

#### Chi nhánh 1: Set Mốc Khởi Điểm (Manual Trigger)
- **ManualTrigger**: Chạy thủ công khi cần
- **SetStart**: Code node — đọc data, tính MD5 hash, lưu vào static data
- **StartSaved**: Trả về JSON xác nhận đã lưu

**Cách dùng**: Mở n8n → Chạy workflow thủ công → Đọc Google Sheet → Tính hash → Lưu làm mốc khởi điểm

#### Chi nhánh 2: Auto Poll (Schedule Trigger)
- **Schedule**: Mỗi 30 giây
- **ReadSheet**: Đọc Google Sheet (A:J)
- **CheckNew**: Code node — so sánh MD5 hash với mốc khởi điểm
- **HasNewData**: IF — có data mới hay không
- **SendToServer**: POST đến `http://192.168.10.112:8888/api/send-data`
- **NoAction**: Không làm gì nếu không có data mới

**Logic so sánh**:
1. Nếu chưa có mốc khởi điểm → bỏ qua, hiện thông báo
2. Nếu hash giống lần trước → không có data mới
3. Nếu hash khác → có data mới → POST đến server

Config:
- `workerId`: `"PTS-PC-B"` (cấu hình theo máy)
- `sheetRange`: `"Sheet1!A:J"` (cấu hình theo sheet)
- Poll interval: 30 giây (có thể thay đổi trong Schedule node)

## Endpoints

### Server (PC-parttime:8888)

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/health` | Kiểm tra server sống |
| GET | `/api/status` | Xem status tất cả workers |
| POST | `/api/send-data` | Gửi data đến worker |
| GET | `/ws/worker` | WebSocket connection cho worker |

#### POST /api/send-data

```json
Headers: { "x-api-key": "andepzai01022005" }
Body: {
  "workerId": "PTS-PC-B",
  "sheetRange": "Sheet1!A1:J1000"
}
```

#### GET /api/status

```json
Headers: { "x-api-key": "andepzai01022005" }
Response: {
  "ok": true,
  "workers": [
    {
      "workerId": "PTS-PC-B",
      "status": "Chưa nhận dữ liệu",
      "lastDataSentAt": "...",
      "lastDataReceivedAt": "..."
    }
  ]
}
```

### Worker (PC44:8787)

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/health` | Kiểm tra worker sống |
| GET | `/api/status` | Xem status worker (chỉ local) |

## Worker Status

| Status | Vietnamese | Ý nghĩa |
|--------|------------|---------|
| QUEUED | Chưa nhận dữ liệu | Đang chờ, sẵn sàng nhận |
| RUNNING | Đang nhận dữ liệu | Đã nhận data, đang xử lý |
| ERROR | Lỗi | Có lỗi xảy ra |

## WebSocket Protocol

### Server → Worker

| Type | Payload | Ý nghĩa |
|------|---------|---------|
| `DATA_DISPATCHED` | `{ csvRows, sheetRange, ... }` | Gửi data đến worker |
| `HEARTBEAT_ACK` | `{ timestamp }` | Xác nhận heartbeat |

### Worker → Server

| Type | Payload | Ý nghĩa |
|------|---------|---------|
| `HEARTBEAT` | `{}` | Heartbeat định kỳ |
| `DATA_RECEIVED` | `{}` | Xác nhận đã nhận data |
| `DATA_FAILED` | `{ error }` | Báo lỗi khi nhận data |

## Log Levels

| Level | Label | Ý nghĩa |
|-------|-------|---------|
| 10 | fatal | Lỗi nghiêm trọng, app thoát |
| 20 | error | Lỗi xảy ra |
| 30 | warn | Cảnh báo |
| 40 | info | Thông tin bình thường |
| 50 | debug | Thông tin debug chi tiết |
| 60 | trace | Thông tin rất chi tiết |

## Deploy

### Server (PC-parttime)
```bash
git pull
# Restart server
```

### Worker (PC44)
```bash
# Copy worker.exe từ PC-parttime
copy \\192.168.10.112\...\deploy\worker.exe C:\Users\3\Desktop\
# Restart worker
```

### n8n Workflow
```bash
npx --yes n8nac push
# Kích hoạt workflow trong n8n UI
```

## Lệnh hữu ích

```bash
# Xem status worker
GET http://192.168.10.112:8888/api/status
Headers: x-api-key: andepzai01022005

# Gửi data đến worker
POST http://192.168.10.112:8888/api/send-data
Headers: x-api-key: andepzai01022005
Body: { "workerId": "PTS-PC-B", "sheetRange": "Sheet1!A1:J10" }

# Build worker
cd apps/worker && npx --yes bun build src/index.ts --compile --outfile ../../deploy/worker.exe

# TypeScript check
cd apps/server && npx --yes tsc --noEmit
cd apps/worker && npx --yes tsc --noEmit
```

## File structure quan trọng

```
apps/server/src/
├── app.ts                    # Server setup, WebSocket route
├── routes/
│   ├── sheet-jobs.ts         # POST /api/send-data
│   └── ws-workers.ts         # GET /api/status
├── services/
│   ├── ws-job-dispatcher.ts  # Quản lý WebSocket workers
│   └── google-sheets.ts      # Đọc Google Sheet

apps/worker/src/
├── app.ts                    # Worker setup, nhận data
├── services/
│   └── ws-client.ts          # WebSocket client kết nối server

workflows/n8n-as-code/
├── DataPTS-Auto.workflow.ts  # n8n Schedule Trigger workflow

deploy/
└── worker.exe                # Built executable

md/
└── PROJECT.md                # File ghi chú này
```

## Multi-machine (làm sau)

- Mỗi worker sẽ chạy data khác nhau
- n8n sẽ phân flow theo workerId
- Worker tự report status về server
