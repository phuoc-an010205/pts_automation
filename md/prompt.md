Tôi muốn xây dựng một hệ thống tự động phân phối job Photoshop trong mạng LAN.

Hệ thống phải có giao diện React để người dùng upload CSV và nhập thông tin job.

Kiến trúc tổng thể:

User
→ React
→ Node.js API
→ Google Sheet
→ n8n
→ Node Job Server
→ Worker Dispatcher
→ Photoshop Worker
→ local COM
→ Photoshop.Application
→ JSX / JSXBIN

# 1. MỤC TIÊU

Người dùng không thao tác trực tiếp với Google Sheet.

Người dùng chỉ sử dụng React Web App.

React cho phép:

* nhập Order Number;
* nhập Line Item ID;
* nhập SKU;
* nhập Product Type;
* upload CSV;
* gửi job.

React gửi dữ liệu tới Node.js Server.

Node.js Server validate dữ liệu, lưu CSV và ghi một dòng mới xuống Google Sheet với STATUS = NEW.

Google Sheet là nguồn dữ liệu trung gian cho n8n.

n8n đọc các dòng mới bằng cursor, làm sạch dữ liệu và gửi job tới Node Job Server.

Node Job Server không được phụ thuộc vào Google Sheet để điều phối worker.

Node Job Server chịu trách nhiệm:

* job queue;
* worker state;
* dispatcher;
* heartbeat;
* retry;
* timeout;
* job status.

# 2. TECH STACK

Frontend:

* React
* Vite
* TypeScript

Backend:

* Node.js
* TypeScript
* Fastify hoặc Express

Database:

* SQLite

Google:

* Google Sheets API
* Service Account

Automation:

* n8n

Photoshop Worker:

* Worker Agent
* HTTP API
* local Windows COM
* Photoshop.Application
* JSX / JSXBIN

Không dùng Remote COM/DCOM.

# 3. REPOSITORY STRUCTURE

photoshop-automation/
apps/
web/
server/
worker/
packages/
shared/
docs/

# 4. REACT FORM

Tạo trang:

/new-job

Fields:

orderNumber
lineItemId
sku
productType
csvFile

Button:

SEND JOB

Validate trước khi submit.

Không cho upload file ngoài .csv.

Giới hạn dung lượng file qua config.

Hiển thị trạng thái upload:

IDLE
UPLOADING
SUCCESS
ERROR

# 5. USER SUBMISSION API

Endpoint:

POST /api/orders

multipart/form-data

Fields:

orderNumber
lineItemId
sku
productType
file

Server phải:

1. validate dữ liệu;
2. validate CSV;
3. tạo submissionId duy nhất;
4. lưu CSV vào:

data/uploads/{submissionId}.csv

5. ghi Google Sheet;
6. trả response cho React.

Ví dụ response:

{
"ok": true,
"submissionId": "SUB-20260829-000001",
"status": "NEW"
}

# 6. GOOGLE SHEET MODEL

Sheet cần các cột tối thiểu:

STATUS
SUBMISSION ID
JOB ID
ORDER NUMBER
LINE ITEM ID
SKU
PRODUCT TYPE
CSV PATH
CREATED AT
STARTED AT
COMPLETED AT
ERROR

Khi Node ghi dữ liệu mới:

STATUS = NEW

JOB ID để trống.

Ví dụ:

NEW
SUB-001
(empty)
#10232
123456
TS02-12345
T-Shirt
data/uploads/SUB-001.csv

# 7. SERVICE ACCOUNT

Node.js Server dùng Google Service Account để ghi Sheet.

Credential lấy từ environment variable hoặc file config ngoài source.

Không hard-code private key.

Không commit credential.

# 8. N8N WORKFLOW

Workflow:

Schedule Trigger
→ Create Cursor
→ Read Google Sheet
→ Filter STATUS = NEW
→ Clean Data
→ Build Job Payload
→ POST /api/jobs
→ Update Google Sheet
→ Save Cursor

Chỉ đọc dữ liệu mới bằng cursor.

Không scan toàn bộ Sheet mỗi lần.

# 9. N8N JOB PAYLOAD

Ví dụ:

{
"idempotencyKey": "google-sheet:design:10532",
"submissionId": "SUB-001",
"sourceRow": 10532,
"orderNumber": "#10232",
"lineItemId": "123456",
"sku": "TS02-12345",
"productType": "T-Shirt",
"csvPath": "data/uploads/SUB-001.csv"
}

# 10. JOB API

Endpoint:

POST /api/jobs

Server phải chống duplicate bằng idempotencyKey.

Nếu key chưa tồn tại:

* tạo job;
* status QUEUED.

Nếu key đã tồn tại:

* trả job cũ;
* không tạo job mới.

Response:

{
"ok": true,
"jobId": "JOB-20260829-000001",
"status": "QUEUED"
}

# 11. JOB MODEL

Fields:

id
idempotencyKey
submissionId
status
payload
assignedWorkerId
createdAt
assignedAt
startedAt
completedAt
failedAt
retryCount
error

Statuses:

QUEUED
ASSIGNED
PROCESSING
COMPLETED
FAILED
RETRY

# 12. N8N UPDATE SHEET

Sau khi POST /api/jobs thành công:

Google Sheet:

STATUS = QUEUED
JOB ID = jobId

Không update QUEUED nếu Server trả lỗi.

# 13. WORKER MODEL

Worker fields:

id
hostname
ip
status
currentJobId
lastSeen
photoshopStatus
version

Statuses:

STARTING
IDLE
RESERVED
BUSY
ERROR
OFFLINE

# 14. WORKER REGISTER

POST /api/workers/register

Body:

{
"workerId": "PTS-PC-01",
"hostname": "DESIGN-PC-01",
"version": "1.0.0"
}

# 15. HEARTBEAT

Worker gửi heartbeat mỗi 5 giây.

POST /api/workers/heartbeat

{
"workerId": "PTS-PC-01",
"status": "IDLE",
"currentJobId": null,
"photoshopStatus": "READY"
}

Nếu quá 30 giây không có heartbeat:

worker = OFFLINE.

Không ghi heartbeat liên tục vào Google Sheet.

Heartbeat chỉ tồn tại trong Server/database.

# 16. DISPATCHER

Dispatcher phải:

1. lấy job QUEUED cũ nhất;
2. lấy worker IDLE;
3. reserve worker atomically;
4. assign job atomically;
5. gửi job tới worker;
6. chờ ACK;
7. chuyển worker BUSY;
8. chuyển job PROCESSING.

Không để:

* hai job claim cùng worker;
* hai worker claim cùng job.

# 17. WORKER API

Worker chạy HTTP server.

Default port:

8787

Endpoints:

GET /health
GET /status
POST /job
POST /cancel

POST /job chỉ nhận khi worker IDLE hoặc RESERVED đúng job.

Nếu BUSY:
HTTP 409.

# 18. PHOTOSHOP CONTROLLER

Tạo abstraction:

PhotoshopController

Methods:

isRunning()
isReady()
start()
executeJob(job)
getStatus()
stop()

Phase đầu sử dụng:

MockPhotoshopController

executeJob:

* đợi 5 giây;
* trả success.

Chưa implement COM ngay.

# 19. PHOTOSHOP COM

Sau khi Mock Worker chạy ổn, tạo:

WindowsPhotoshopController

Sử dụng local Windows COM:

Photoshop.Application

COM chỉ chạy trên chính máy Worker.

Worker Server không dùng COM remote.

Sau này controller sẽ chạy:

JSX / JSXBIN

và truyền csvPath cho Photoshop automation.

# 20. WORKER RESULT

Worker báo started:

POST /api/jobs/:jobId/started

Worker báo completed:

POST /api/jobs/:jobId/completed

Worker báo failed:

POST /api/jobs/:jobId/failed

Sau COMPLETED hoặc FAILED:

worker → IDLE.

Dispatcher tự động phân job tiếp theo.

# 21. UPDATE GOOGLE SHEET RESULT

Node Server hoặc n8n có thể update Sheet khi job thay đổi trạng thái.

Thiết kế event để sau này có thể update:

QUEUED
PROCESSING
DONE
FAILED

Không để Worker gọi Google Sheets trực tiếp.

# 22. REACT DASHBOARD

Ngoài /new-job, tạo:

/dashboard

Hiển thị:

Workers:

* worker ID
* IDLE
* RESERVED
* BUSY
* OFFLINE
* current job
* Photoshop status
* last seen

Jobs:

* job ID
* submission ID
* order number
* status
* worker
* created time
* processing duration
* error

Summary:

Online Workers
Idle Workers
Busy Workers
Queued Jobs
Processing Jobs
Completed Jobs
Failed Jobs

Ban đầu dùng polling 3 giây.

Chưa cần WebSocket.

# 23. SECURITY

Tách API key:

N8N_API_KEY
WORKER_API_KEY

Không dùng chung một key cho tất cả.

Validate request.

Không hard-code secret.

Server chỉ listen LAN theo config.

# 24. ERROR CASES

Phải thiết kế cho:

n8n gửi duplicate.
Server restart.
Worker restart.
Worker mất mạng.
Worker offline giữa job.
Photoshop crash.
Job timeout.
Worker BUSY nhưng Server gửi job.
Worker hoàn thành nhưng callback thất bại.
CSV bị xóa.
CSV không hợp lệ.

Job không được biến mất.

Không sử dụng database.

Không sử dụng SQLite, PostgreSQL hoặc Redis ở phiên bản đầu.

Google Sheet là nơi lưu trạng thái nghiệp vụ lâu dài.

Node.js Server chỉ giữ trạng thái runtime trong memory:

* danh sách workers;
* trạng thái worker;
* lastSeen;
* currentJobId;
* job queue tạm thời.

Có thể sử dụng:

Map
Array

Ví dụ:

const workers = new Map();
const jobs = [];

Google Sheet giữ:

SUBMISSION ID
JOB ID
STATUS
ORDER NUMBER
LINE ITEM ID
SKU
PRODUCT TYPE
CSV PATH
CREATED AT
STARTED AT
COMPLETED AT
ERROR

Job status trên Google Sheet:

NEW
QUEUED
PROCESSING
DONE
FAILED

Nếu Node Server restart:

* không được làm mất dữ liệu nguồn;
* khi server hoạt động lại, n8n có thể đọc lại các dòng có STATUS = NEW hoặc QUEUED để tái tạo queue;
* phải dùng JOB ID hoặc idempotencyKey để tránh tạo job trùng.

Không implement database trong project hiện tại.


