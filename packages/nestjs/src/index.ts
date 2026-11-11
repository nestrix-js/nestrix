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
  NestrixExportOptions,
  NestrixHttpOptions,
  NestrixIgnoreOptions,
  NestrixIntegrationOptions,
  NestrixLogsOptions,
  NestrixMethodOptions,
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
export { Span, type SpanOptions, withSpan } from "./span.js";
export { nestrixSpanProcessor } from "./store/span-processor.js";
