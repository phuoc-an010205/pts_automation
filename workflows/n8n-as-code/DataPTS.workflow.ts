import { workflow, node, links } from '@n8n-as-code/transformer';

// <workflow-map>
// Workflow : DataPTS
// Nodes   : 5  |  Connections: 4
//
// NODE INDEX
// ──────────────────────────────────────────────────────────────────
// Property name                    Node type (short)         Flags
// Webhook                            webhook
// CreateJob                          httpRequest
// Success                            if
// SuccessResponse                    respondToWebhook
// ErrorResponse                      respondToWebhook
//
// ROUTING MAP
// ──────────────────────────────────────────────────────────────────
// Webhook
//    → CreateJob
//      → Success
//        → SuccessResponse
//       .out(1) → ErrorResponse
// </workflow-map>

// =====================================================================
// METADATA DU WORKFLOW
// =====================================================================

@workflow({
    id: 'EHwjAjTEutPtF4ZQ',
    name: 'DataPTS',
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
export class DataptsWorkflow {
    // =====================================================================
    // CONFIGURATION DES NOEUDS
    // =====================================================================

    @node({
        id: '1d0d9c8b-d58e-45cb-ad65-6bbdd6027123',
        webhookId: '5910c14d-28a5-4d78-b2f8-cf8ffe8db7a0',
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        version: 2.1,
        position: [-600, 240],
    })
    Webhook = {
        path: 'pts-job',
        httpMethod: 'POST',
        responseMode: 'responseNode',
        options: {},
    };

    @node({
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'Create Job',
        type: 'n8n-nodes-base.httpRequest',
        version: 4.2,
        position: [-200, 240],
    })
    CreateJob = {
        method: 'POST',
        url: 'http://192.168.10.112:8888/api/jobs-from-sheet',
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
            '={{ JSON.stringify({ itemCode: $json.itemCode, action: $json.action, path: $json.path, productType: $json.productType, layerNameList: $json.layerNameList, replacements: $json.replacements, outputPath: $json.outputPath, outputExt: $json.outputExt, mockupPath: $json.mockupPath, imageQuantity: $json.imageQuantity, sheetRange: $json.sheetRange ?? "Sheet1!A1:J1000" }) }}',
        options: {},
    };

    @node({
        id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
        name: 'Success?',
        type: 'n8n-nodes-base.if',
        version: 2,
        position: [200, 240],
    })
    Success = {
        conditions: {
            options: {
                caseSensitive: true,
                leftValue: '',
                typeValidation: 'strict',
            },
            conditions: [
                {
                    id: 'condition-ok',
                    leftValue: '={{ $json.ok }}',
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
        id: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
        name: 'Success Response',
        type: 'n8n-nodes-base.respondToWebhook',
        version: 1.5,
        position: [600, 140],
    })
    SuccessResponse = {
        respondWith: 'json',
        responseBody:
            '={{ JSON.stringify({ ok: true, jobId: $json.jobId, status: $json.status, message: "Job created successfully" }) }}',
        options: {
            responseCode: 200,
        },
    };

    @node({
        id: 'd4e5f6a7-b8c9-0123-defa-234567890123',
        name: 'Error Response',
        type: 'n8n-nodes-base.respondToWebhook',
        version: 1.5,
        position: [600, 340],
    })
    ErrorResponse = {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ ok: false, error: $json.error?.message || "Unknown error" }) }}',
        options: {
            responseCode: 500,
        },
    };

    // =====================================================================
    // ROUTAGE ET CONNEXIONS
    // =====================================================================

    @links()
    defineRouting() {
        this.Webhook.out(0).to(this.CreateJob.in(0));
        this.CreateJob.out(0).to(this.Success.in(0));
        this.Success.out(0).to(this.SuccessResponse.in(0));
        this.Success.out(1).to(this.ErrorResponse.in(0));
    }
}
