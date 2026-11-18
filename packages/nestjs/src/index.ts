export {
  type RecordErrorOptions,
  recordError,
} from "./errors/record-error.js";
export {
  getExportStatus,
  type NestrixExportFailure,
  type NestrixExportFailureReason,
  type NestrixExportSignal,
  type NestrixExportState,
  type NestrixExportStatus,
  type NestrixSignalExportStatus,
} from "./export-status.js";
export {
  type BullmqAttributes,
  type BullmqAttributeValue,
  type BullmqSpan,
  type BullmqTelemetry,
  type BullmqTelemetryOptions,
  bullmqTelemetry,
} from "./jobs/bullmq.js";
export { emitLog, type NestrixLogRecord } from "./logs/emit.js";
export { NestrixLogger } from "./logs/logger.js";
export { getTraceIds, type TraceIds } from "./logs/trace-ids.js";
export {
  composeInstrument,
  type NestInstrument,
  NestrixInstrument,
} from "./methods/instrument.js";
export {
  instrumentClient,
  nestrixPreRequestHook,
} from "./microservices/index.js";
export {
  NestrixModule,
  type NestrixModuleAsyncOptions,
} from "./nestrix.module.js";
export type {
  ClassMatcher,
  NestrixEnhancerKind,
  NestrixErrorsOptions,
  NestrixExportOptions,
  NestrixHttpOptions,
  NestrixIgnoreOptions,
  NestrixIntegrationsOptions,
  NestrixLogsOptions,
  NestrixMethodsOptions,
  NestrixMetricsOptions,
  NestrixModuleOptions,
  NestrixOtlpOptions,
  NestrixQueueOptions,
  NestrixStoreOptions,
  NestrixUiCustomAuth,
  NestrixUiOptions,
  NestrixUiTokenAuth,
  RedactableSpan,
  RedactHook,
  UrlMatcher,
} from "./options.js";
export { Span, withSpan } from "./span.js";
export { nestrixSpanProcessor } from "./store/span-processor.js";
