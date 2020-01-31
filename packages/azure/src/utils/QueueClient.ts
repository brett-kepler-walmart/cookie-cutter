/*
Copyright (c) Walmart Inc.

This source code is licensed under the Apache 2.0 license found in the
LICENSE file in the root directory of this source tree.
*/

import {
    DefaultComponentContext,
    failSpan,
    IComponentContext,
    IMetrics,
    IMetricTags,
    IRequireInitialization,
    OpenTracingTagKeys,
} from "@walmartlabs/cookie-cutter-core";
import {
    createQueueService,
    LinearRetryPolicyFilter,
    QueueService,
    ServiceResponse,
} from "azure-storage";
import { FORMAT_HTTP_HEADERS, Span, SpanContext, Tags, Tracer } from "opentracing";
import { IQueueConfiguration } from "../streaming";

interface IQueueRequestOptions {
    /**
     * Specifies the queue name to use other than the configured default
     */
    queueName?: string;
}

enum QueueMetrics {
    Write = "cookie_cutter.azure_queue_client.write",
    Read = "cookie_cutter.azure_queue_client.read",
    MarkAsProcessed = "cookie_cutter.azure_queue_client.mark_as_processed",
    QueueMetadata = "cookie_cutter.azure_queue_client.queue_metadata",
}
enum QueueMetricResults {
    Success = "success",
    Error = "error",
    ErrorTooBig = "error.too_big",
}

export enum QueueOpenTracingTagKeys {
    QueueName = "queue.name",
}

export interface IQueueCreateMessageOptions extends IQueueRequestOptions {
    /**
     * (FROM AZURE DOCS)
     * The time-to-live interval for the message, in seconds. The maximum time-to-live allowed is 7 days. If this parameter
     * is omitted, the default time-to-live is 7 days (604800 seconds)
     */
    messageTimeToLive?: number;
    /**
     * (FROM AZURE DOCS)
     * Specifies the new visibility timeout value, in seconds, relative to server time. The new value must be larger than or
     * equal to 0, and cannot be larger than 7 days (604800 seconds). The visibility timeout of a message cannot be set to a value later than
     * the expiry time (calculated based on time-to-live when updating message). visibilitytimeout should be set to a value smaller than the time-to-live value.
     */
    visibilityTimeout?: number;
}

export interface IQueueReadOptions extends IQueueRequestOptions {
    /**
     * (FROM AZURE DOCS)
     * A nonzero integer value that specifies the number of messages to retrieve from the queue,
     * up to a maximum of 32. By default, a single message is retrieved from the queue with this operation.
     */
    numOfMessages?: number;

    /**
     * (FROM AZURE DOCS)
     * Required if not peek only. Specifies the new visibility timeout value, in seconds,
     * relative to server time. The new value must be larger than or equal to 0, and cannot be larger than 7 days (604800 seconds).
     * The visibility timeout of a message can be set to a value later than the expiry time.
     */
    visibilityTimeout?: number;
}

export type IQueueMessage = QueueService.QueueMessageResult & {
    headers?: Record<string, string>;
    payload?: unknown;
};

export class QueueClient implements IRequireInitialization {
    private readonly queueService: QueueService;
    public readonly defaultQueue: string;
    private tracer: Tracer;
    private metrics: IMetrics;
    private spanOperationName = "Azure Queue Client Call";

    constructor(private config: IQueueConfiguration) {
        this.defaultQueue = config.queueName;
        this.tracer = DefaultComponentContext.tracer;
        this.metrics = DefaultComponentContext.metrics;

        const { retryCount, retryInterval } = config;
        this.queueService = createQueueService(config.storageAccount, config.storageAccessKey);
        if (retryCount > 0) {
            const retryOperations = new LinearRetryPolicyFilter(retryCount, retryInterval);
            this.queueService = this.queueService.withFilter(retryOperations);
        }
    }

    public async initialize(context: IComponentContext) {
        this.tracer = context.tracer;
        this.metrics = context.metrics;
    }

    private generateMetricTags(
        queueName: string,
        statusCode: number | undefined,
        result: QueueMetricResults
    ): IMetricTags {
        const tags: { [key: string]: any } = {
            queue_name: queueName,
            storage_account: this.config.storageAccount,
            result,
        };
        if (statusCode) {
            tags.status_code = statusCode;
        }
        return tags;
    }

    private spanLogAndSetTags(
        span: Span,
        kind: string,
        funcName: string,
        queueName: string,
        logObj: any
    ): void {
        span.log(logObj);
        span.setTag(Tags.SPAN_KIND, kind);
        span.setTag(Tags.MESSAGE_BUS_DESTINATION, queueName);
        span.setTag(Tags.COMPONENT, "cookie-cutter-azure");
        span.setTag(Tags.DB_INSTANCE, this.config.storageAccount);
        span.setTag(Tags.DB_TYPE, "AzureQueue");
        span.setTag(Tags.PEER_SERVICE, "AzureQueue");
        span.setTag(OpenTracingTagKeys.FunctionName, funcName);
        span.setTag(QueueOpenTracingTagKeys.QueueName, queueName);
    }

    public write(
        spanContext: SpanContext,
        payload: any,
        headers: Record<string, string>,
        options?: IQueueCreateMessageOptions
    ): Promise<IQueueMessage> {
        const span = this.tracer.startSpan(this.spanOperationName, { childOf: spanContext });
        const queueName = (options && options.queueName) || this.defaultQueue;
        const kind = spanContext ? Tags.SPAN_KIND_RPC_CLIENT : undefined;
        this.spanLogAndSetTags(span, kind, this.write.name, queueName, { queue: queueName });
        this.tracer.inject(span, FORMAT_HTTP_HEADERS, headers);
        const text = JSON.stringify({
            payload,
            headers,
        });

        return new Promise<IQueueMessage>((resolve, reject) => {
            const { sizeKb, isTooBig } = this.isMessageTooBig(text);
            span.log({ sizeKb });
            if (isTooBig) {
                const error: Error & { code?: number } = new Error(
                    "Queue Message too big, must be less then 64kb. is: " + sizeKb
                );
                error.code = 413;
                failSpan(span, error);
                span.finish();
                this.metrics.increment(
                    QueueMetrics.Write,
                    this.generateMetricTags(queueName, undefined, QueueMetricResults.ErrorTooBig)
                );
                return reject(error);
            }
            this.queueService.createMessage(
                queueName,
                text,
                options,
                (
                    err: Error & { code?: number },
                    message: QueueService.QueueMessageResult,
                    response: ServiceResponse
                ) => {
                    if (err) {
                        failSpan(span, err);
                    }
                    span.setTag(Tags.HTTP_STATUS_CODE, response.statusCode);
                    span.finish();
                    if (err) {
                        err.code = response.statusCode;
                        this.metrics.increment(
                            QueueMetrics.Write,
                            this.generateMetricTags(
                                queueName,
                                response.statusCode,
                                QueueMetricResults.Error
                            )
                        );
                        reject(err);
                    } else {
                        this.metrics.increment(
                            QueueMetrics.Write,
                            this.generateMetricTags(
                                queueName,
                                response.statusCode,
                                QueueMetricResults.Success
                            )
                        );
                        resolve({
                            ...message,
                            headers,
                            payload,
                        });
                    }
                }
            );
        });
    }

    public async read(
        spanContext: SpanContext,
        options?: IQueueReadOptions
    ): Promise<IQueueMessage[]> {
        const span = this.tracer.startSpan(this.spanOperationName, { childOf: spanContext });
        const { queueName, visibilityTimeout, numOfMessages } = Object.assign(
            {},
            {
                queueName: this.defaultQueue,
            },
            options || {}
        );
        const kind = spanContext ? Tags.SPAN_KIND_RPC_CLIENT : undefined;
        this.spanLogAndSetTags(span, kind, this.read.name, queueName, {
            queueName,
            visibilityTimeout,
            numOfMessages,
        });

        return new Promise<IQueueMessage[]>((resolve, reject) => {
            this.queueService.getMessages(
                queueName,
                { visibilityTimeout, numOfMessages },
                (
                    err: Error,
                    results: QueueService.QueueMessageResult[],
                    response: ServiceResponse
                ) => {
                    if (err) {
                        span.log({ error: err });
                        span.setTag(Tags.ERROR, true);
                    }
                    span.setTag(Tags.HTTP_STATUS_CODE, response.statusCode);
                    span.finish();
                    if (err) {
                        this.metrics.increment(
                            QueueMetrics.Read,
                            this.generateMetricTags(
                                queueName,
                                response.statusCode,
                                QueueMetricResults.Error
                            )
                        );
                        reject(err);
                    } else {
                        this.metrics.increment(
                            QueueMetrics.Read,
                            this.generateMetricTags(
                                queueName,
                                response.statusCode,
                                QueueMetricResults.Success
                            )
                        );
                        resolve(
                            results.map<IQueueMessage>((result) => {
                                const mesageObj = JSON.parse(result.messageText) as {
                                    headers: Record<string, string>;
                                    payload: unknown;
                                };
                                return {
                                    ...result,
                                    ...mesageObj,
                                };
                            })
                        );
                    }
                }
            );
        });
    }

    public markAsProcessed(
        spanContext: SpanContext,
        messageId: string,
        popReceipt: string,
        queueName: string = this.defaultQueue
    ): Promise<void> {
        const span = this.tracer.startSpan(this.spanOperationName, { childOf: spanContext });
        const kind = spanContext ? Tags.SPAN_KIND_RPC_CLIENT : undefined;
        this.spanLogAndSetTags(span, kind, this.markAsProcessed.name, queueName, {
            queueName,
            messageId,
            popReceipt,
        });

        return new Promise<void>((resolve, reject) => {
            this.queueService.deleteMessage(
                queueName,
                messageId,
                popReceipt,
                (err: Error, response: ServiceResponse) => {
                    if (err) {
                        span.log({ error: err });
                        span.setTag(Tags.ERROR, true);
                    }
                    span.setTag(Tags.HTTP_STATUS_CODE, response.statusCode);
                    span.finish();
                    if (err) {
                        this.metrics.increment(
                            QueueMetrics.MarkAsProcessed,
                            this.generateMetricTags(
                                queueName,
                                response.statusCode,
                                QueueMetricResults.Error
                            )
                        );
                        reject(err);
                    } else {
                        this.metrics.increment(
                            QueueMetrics.MarkAsProcessed,
                            this.generateMetricTags(
                                queueName,
                                response.statusCode,
                                QueueMetricResults.Success
                            )
                        );
                        resolve();
                    }
                }
            );
        });
    }

    public queueMetadata(
        spanContext: SpanContext,
        queueName: string
    ): Promise<QueueService.QueueResult> {
        const span = this.tracer.startSpan(this.spanOperationName, { childOf: spanContext });
        const kind = spanContext ? Tags.SPAN_KIND_RPC_CLIENT : undefined;
        this.spanLogAndSetTags(span, kind, this.queueMetadata.name, queueName, { queueName });

        return new Promise((resolve, reject) => {
            this.queueService.getQueueMetadata(
                queueName,
                (err: Error, result: QueueService.QueueResult, response: ServiceResponse) => {
                    if (err) {
                        span.log({ error: err });
                        span.setTag(Tags.ERROR, true);
                    }
                    span.setTag(Tags.HTTP_STATUS_CODE, response.statusCode);
                    span.finish();
                    if (err) {
                        this.metrics.increment(
                            QueueMetrics.QueueMetadata,
                            this.generateMetricTags(
                                queueName,
                                response.statusCode,
                                QueueMetricResults.Error
                            )
                        );
                        reject(err);
                    } else {
                        this.metrics.increment(
                            QueueMetrics.QueueMetadata,
                            this.generateMetricTags(
                                queueName,
                                response.statusCode,
                                QueueMetricResults.Success
                            )
                        );
                        resolve(result);
                    }
                }
            );
        });
    }

    private getKB(input: string | Buffer) {
        const kb = (n: number) => n / 1024;
        if (typeof input === "string") {
            // QueueClient calculates final kb by creating a buffer from the input and encoding in base64.
            // Since we don't want to base64 twice to calculate things we can take byte length and multiply
            // by 8 / 6 to get final number of bytes that would have been output by base64. Every 6 bits of data
            // is encoded into one base64 character.
            // https://github.com/Azure/azure-storage-node/blob/0557d02cd2116046db1a2d7fc61a74aa28c8b557/lib/services/queue/queuemessageencoder.js#L76
            // https://stackoverflow.com/questions/13378815/base64-length-calculation
            return kb(Math.ceil((Buffer.byteLength(input, "utf8") * 8) / 6));
        }
        return kb(input.byteLength);
    }

    private isMessageTooBig(input: string | Buffer) {
        const sizeKb = this.getKB(input);
        return {
            sizeKb,
            isTooBig: sizeKb >= 64,
        };
    }
}