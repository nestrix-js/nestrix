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
  NestrixMethodOptions,
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
