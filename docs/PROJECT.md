# PTS Automation - Ghi chú

## Kiến trúc tổng quan

```
n8n → Server (192.168.10.112:8888) → Worker/PC44 (192.168.10.144:8787)
         ↓                                    ↓
    Đọc Google Sheet                  Nhận data, xác nhận
    (service account)                 (qua WebSocket)
```

## Machines

| Machine | IP | Vai trò |
|---------|-----|---------|
| PC-parttime | 192.168.10.112 | Server (Fastify + WebSocket) |
| PC44 | 192.168.10.144 | Worker (nhận data, xử lý) |

## API Keys

- Server API Key: `andepzai01022005`
- Server Callback API Key: `andepzai01022005`
- Worker API Key: `andepzai01022005`

## Google Sheet

- Spreadsheet ID: `1O3S26f84qsZEidq2YAu0tSO7QGJSWM7cPbfZmbc1RKw`
- Service Account: `service-account.json` (gitignored)
- CSV columns: `item_code, action, path, product_type, layer_name_list, replacements, output path, output ext, mockup path, image quantity`

## Flow hiện tại

1. n8n POST `/api/send-data` → Server
2. Server đọc Google Sheet bằng service account
3. Server push data đến PC44 qua WebSocket
4. PC44 nhận data → xác nhận (`DATA_RECEIVED`)
5. PC44 giữ status "Đang nhận dữ liệu"

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
  "sheetRange": "Sheet1!A1:J10",
  "itemCode": "...",
  "action": "...",
  "path": "...",
  "productType": "...",
  "layerNameList": "..."
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

- Server: `git pull` trên PC-parttime → restart server
- Worker: copy `deploy/worker.exe` sang PC44 → restart worker
- n8n: push workflow qua `npx --yes n8nac push`

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

deploy/
└── worker.exe                # Built executable
```
