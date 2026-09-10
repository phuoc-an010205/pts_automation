import { workflow, node, links } from '@n8n-as-code/transformer';

// <workflow-map>
// Workflow : DataPTS-Auto
// Nodes   : 8  |  Connections: 7
//
// NODE INDEX
// ──────────────────────────────────────────────────────────────────
// Property name                    Node type (short)         Flags
// ManualTrigger                    manualTrigger
// SetStart                         code
// StartSaved                       respondToWebhook
// Schedule                         scheduleTrigger
// ReadSheet                        googleSheets
// CheckNew                         code
// HasNewData                       if
// SendToServer                     httpRequest
// NoAction                         noOp
//
// ROUTING MAP
// ──────────────────────────────────────────────────────────────────
// ManualTrigger → SetStart → StartSaved
// Schedule → ReadSheet → CheckNew → HasNewData
//   .out(0) → SendToServer
//   .out(1) → NoAction
// </workflow-map>

@workflow({
    id: 'DataPTS-Auto',
    name: 'DataPTS-Auto',
    active: false,
    isArchived: false,
    settings: {
        timezone: 'Asia/Ho_Chi_Minh',
        executionOrder: 'v1',
        callerPolicy: 'workflowsFromSameOwner',
        availableInMCP: false,
    },
})
export class DataPtsAutoWorkflow {

    // =====================================================================
    // CHI NHANH 1: SET MOC KHOI DIEM (Manual Trigger)
    // =====================================================================

    @node({
        id: 'manual-trigger-1',
        name: 'ManualTrigger',
        type: 'n8n-nodes-base.manualTrigger',
        version: 1,
        position: [-600, 100],
    })
    ManualTrigger = {};

    @node({
        id: 'code-set-start',
        name: 'SetStart',
        type: 'n8n-nodes-base.code',
        version: 2,
        position: [-400, 100],
    })
    SetStart = {
        mode: 'runOnceForAllItems',
        jsCode: `
const data = JSON.stringify($input.all());
const staticData = $getWorkflowStaticData('global');
const crypto = require('crypto');
const hash = crypto.createHash('md5').update(data).digest('hex');

staticData.startHash = hash;
staticData.startRowCount = $input.all().length;
staticData.startedAt = new Date().toISOString();

return {
    json: {
        ok: true,
        message: 'Da luu moc khoi diem',
        startHash: hash,
        rowCount: $input.all().length,
        startedAt: staticData.startedAt,
    }
};
`,
    };

    @node({
        id: 'respond-start',
        name: 'StartSaved',
        type: 'n8n-nodes-base.respondToWebhook',
        version: 1.5,
        position: [-200, 100],
    })
    StartSaved = {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify($json) }}',
        options: {
            responseCode: 200,
        },
    };

    // =====================================================================
    // CHI NHANH 2: AUTO POLL (Schedule Trigger)
    // =====================================================================

    @node({
        id: 'schedule-trigger-1',
        name: 'Schedule',
        type: 'n8n-nodes-base.scheduleTrigger',
        version: 1.2,
        position: [-600, 340],
    })
    Schedule = {
        rule: {
            interval: [
                {
                    field: 'seconds',
                    secondsInterval: 30,
                },
            ],
        },
    };

    @node({
        id: 'google-sheets-1',
        name: 'ReadSheet',
        type: 'n8n-nodes-base.googleSheets',
        version: 4.5,
        position: [-400, 340],
    })
    ReadSheet = {
        operation: 'read',
        documentId: {
            __rl: true,
            mode: 'id',
            value: '1O3S26f84qsZEidq2YAu0tSO7QGJSWM7cPbfZmbc1RKw',
        },
        sheetName: {
            __rl: true,
            mode: 'list',
            value: 'Sheet1',
        },
        options: {
            range: 'A:J',
        },
    };

    @node({
        id: 'code-check-new',
        name: 'CheckNew',
        type: 'n8n-nodes-base.code',
        version: 2,
        position: [-200, 340],
    })
    CheckNew = {
        mode: 'runOnceForAllItems',
        jsCode: `
const items = $input.all();
const data = JSON.stringify(items);
const staticData = $getWorkflowStaticData('global');
const crypto = require('crypto');
const currentHash = crypto.createHash('md5').update(data).digest('hex');

// Kiem tra co moc khoi diem chua
const startHash = staticData.startHash;
if (!startHash) {
    return { json: { hasNewData: false, reason: 'Chua co moc khoi diem. Hay chay Manual Trigger truoc.' } };
}

// Kiem tra co thay doi khong
const lastHash = staticData.lastHash || startHash;
if (currentHash === lastHash) {
    return { json: { hasNewData: false, reason: 'Khong co du lieu moi' } };
}

// Co du lieu moi
staticData.lastHash = currentHash;
return {
    json: {
        hasNewData: true,
        rowsCount: items.length,
        sheetRange: 'Sheet1!A:J',
    }
};
`,
    };

    @node({
        id: 'if-has-new',
        name: 'HasNewData',
        type: 'n8n-nodes-base.if',
        version: 2,
        position: [0, 340],
    })
    HasNewData = {
        conditions: {
            options: {
                caseSensitive: true,
                leftValue: '',
                typeValidation: 'strict',
            },
            conditions: [
                {
                    id: 'condition-new',
                    leftValue: '={{ $json.hasNewData }}',
                    rightValue: true,
                    operator: {
                        type: 'boolean',
                        operation: 'true',
                    },
                },
            ],
            combinator: 'and',
        },
    };

    @node({
        id: 'http-send-server',
        name: 'SendToServer',
        type: 'n8n-nodes-base.httpRequest',
        version: 4.2,
        position: [300, 240],
    })
    SendToServer = {
        method: 'POST',
        url: 'http://192.168.10.112:8888/api/send-data',
        sendHeaders: true,
        headerParameters: {
            parameters: [
                {
                    name: 'x-api-key',
                    value: 'andepzai01022005',
                },
            ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ workerId: "PTS-PC-B", sheetRange: $json.sheetRange }) }}',
        options: {},
    };

    @node({
        id: 'no-op-1',
        name: 'NoAction',
        type: 'n8n-nodes-base.noOp',
        version: 1,
        position: [300, 440],
    })
    NoAction = {};

    // =====================================================================
    // ROUTAGE
    // =====================================================================

    @links()
    defineRouting() {
        // Chi nhanh 1: Set moc khoi diem
        this.ManualTrigger.out(0).to(this.SetStart.in(0));
        this.SetStart.out(0).to(this.StartSaved.in(0));

        // Chi nhanh 2: Auto poll
        this.Schedule.out(0).to(this.ReadSheet.in(0));
        this.ReadSheet.out(0).to(this.CheckNew.in(0));
        this.CheckNew.out(0).to(this.HasNewData.in(0));
        this.HasNewData.out(0).to(this.SendToServer.in(0));
        this.HasNewData.out(1).to(this.NoAction.in(0));
    }
}
