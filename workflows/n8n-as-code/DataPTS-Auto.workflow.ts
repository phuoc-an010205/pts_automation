import { workflow, node, links } from '@n8n-as-code/transformer';

// <workflow-map>
// Workflow : DataPTS-Auto
// Nodes   : 6  |  Connections: 5
//
// NODE INDEX
// ──────────────────────────────────────────────────────────────────
// Property name                    Node type (short)         Flags
// Schedule                         scheduleTrigger
// ReadSheet                        googleSheets
// CheckNew                         code
// HasNewData                       if
// SendToServer                     httpRequest
// NoAction                         noOp
//
// ROUTING MAP
// ──────────────────────────────────────────────────────────────────
// Schedule
//    → ReadSheet
//      → CheckNew
//        → HasNewData
//          .out(0) → SendToServer
//          .out(1) → NoAction
// </workflow-map>

@workflow({
    id: 'DataPTS-Auto',
    name: 'DataPTS-Auto',
    active: true,
    isArchived: false,
    settings: {
        executionOrder: 'v1',
        binaryMode: 'separate',
        availableInMCP: false,
        timeSavedMode: 'fixed',
        timezone: 'Asia/Ho_Chi_Minh',
        callerPolicy: 'workflowsFromSameOwner',
    },
})
export class DataPtsAutoWorkflow {

    @node({
        id: 'schedule-trigger-1',
        name: 'Schedule',
        type: 'n8n-nodes-base.scheduleTrigger',
        version: 1.2,
        position: [-600, 240],
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
        position: [-400, 240],
    })
    ReadSheet = {
        operation: 'read',
        documentId: {
            __rl: true,
            mode: 'list',
            value: '1O3S26f84qsZEidq2YAu0tSO7QGJSWM7cPbfZmbc1RKw',
        },
        sheetName: {
            __rl: true,
            mode: 'list',
            value: 'Sheet1',
        },
        options: {
            range: 'A1:J1000',
        },
    };

    @node({
        id: 'code-check-new',
        name: 'CheckNew',
        type: 'n8n-nodes-base.code',
        version: 2,
        position: [-200, 240],
    })
    CheckNew = {
        mode: 'runOnceForEachItem',
        jsCode: `
const data = JSON.stringify($input.all());
const staticData = $getWorkflowStaticData('global');
const lastHash = staticData.lastHash || '';
const currentHash = require('crypto').createHash('md5').update(data).digest('hex');

if (currentHash === lastHash) {
    return { json: { hasNewData: false } };
}

staticData.lastHash = currentHash;
return {
    json: {
        hasNewData: true,
        rowsCount: $input.all().length,
        sheetRange: 'Sheet1!A1:J1000',
    }
};
`,
    };

    @node({
        id: 'if-has-new',
        name: 'HasNewData',
        type: 'n8n-nodes-base.if',
        version: 2,
        position: [0, 240],
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
        position: [300, 140],
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
        jsonBody:
            '={{ JSON.stringify({ workerId: "PTS-PC-B", sheetRange: $json.sheetRange }) }}',
        options: {},
    };

    @node({
        id: 'no-op-1',
        name: 'NoAction',
        type: 'n8n-nodes-base.noOp',
        version: 1,
        position: [300, 340],
    })
    NoAction = {};

    @links()
    defineRouting() {
        this.Schedule.out(0).to(this.ReadSheet.in(0));
        this.ReadSheet.out(0).to(this.CheckNew.in(0));
        this.CheckNew.out(0).to(this.HasNewData.in(0));
        this.HasNewData.out(0).to(this.SendToServer.in(0));
        this.HasNewData.out(1).to(this.NoAction.in(0));
    }
}
