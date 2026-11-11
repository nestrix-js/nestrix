/**
 * What the microservice server and client instrumentation share (backlog P4-01, spike P4-S1):
 * whether Nestrix is active, fault injection for tests, attribute names, transport names, pattern
 * normalisation and reading packet metadata.
 *
 * `@nestjs/microservices` is an optional peer: nothing here imports it, not even for types.
 * Transports are recognised by their class names, which are part of Nest's public API
 * (`TcpContext`, `ClientRedis`, ...). Imports `@opentelemetry/api` only (AGENTS.md rule 5).
 */
import type { TextMapGetter } from "@opentelemetry/api";

export const TRACER_NAME = "@nestrix/nestjs";

// Messaging semantic conventions, still incubating in `@opentelemetry/semantic-conventions`
// 1.45.0 (`experimental_attributes`). Copied as the package advises for incubating names.
export const ATTR_MESSAGING_SYSTEM = "messaging.system";
export const ATTR_MESSAGING_DESTINATION_NAME = "messaging.destination.name";
export const ATTR_MESSAGING_OPERATION_TYPE = "messaging.operation.type";
export const MESSAGING_OPERATION_PROCESS = "process";
export const MESSAGING_OPERATION_SEND = "send";
/** Set on a client span whose caller unsubscribed before any reply, value or completion. */
export const ATTR_NESTRIX_MESSAGING_CANCELLED = "nestrix.messaging.cancelled";

/** Longest pattern recorded; a longer one is cut and marked with a trailing `…`. */
const MAX_PATTERN_LENGTH = 256;

// ---------------------------------------------------------------------------------------------
// Activation: the module's provider turns this on while an enabled Nestrix application runs.
// Wrappers installed by `instrumentClient` and the user-registered pre-request hook check it at
// call time, so they pass straight through when Nestrix is disabled or shut down.
// ---------------------------------------------------------------------------------------------

let activeReferences = 0;

/** Takes a reference; the returned release is idempotent. */
export function activateMicroservices(): () => void {
  activeReferences++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeReferences = Math.max(0, activeReferences - 1);
  };
}

export function microservicesActive(): boolean {
  return activeReferences > 0;
}

// ---------------------------------------------------------------------------------------------
// Fault injection (tests only; not exported from the package entry point)
// ---------------------------------------------------------------------------------------------

let faultInjector: ((site: string) => void) | undefined;

/** Internal, for tests: `fn` runs at the start of every guarded body and may throw. */
export function setMicroservicesFaultForTests(
  fn: ((site: string) => void) | undefined,
): void {
  faultInjector = fn;
}

/** Called first inside each guarded body. */
export function fault(site: string): void {
  if (faultInjector !== undefined) faultInjector(site);
}

// ---------------------------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------------------------

/** `messaging.system` by RPC context class (server side). */
const CONTEXT_TRANSPORTS: Readonly<Record<string, string>> = {
  TcpContext: "tcp",
  RedisContext: "redis",
  NatsContext: "nats",
  KafkaContext: "kafka",
  RmqContext: "rabbitmq",
  MqttContext: "mqtt",
};

/** `messaging.system` by client class (client side). */
const CLIENT_TRANSPORTS: Readonly<Record<string, string>> = {
  ClientTCP: "tcp",
  ClientRedis: "redis",
  ClientNats: "nats",
  ClientKafka: "kafka",
  ClientRMQ: "rabbitmq",
  ClientMqtt: "mqtt",
  ClientGrpcProxy: "grpc",
};

/**
 * The first class name along `value`'s prototype chain that `table` knows, so a user subclass of
 * a built-in client or context still counts. `undefined` for a custom transport.
 */
function transportByClass(
  value: unknown,
  table: Readonly<Record<string, string>>,
): string | undefined {
  try {
    let proto: unknown =
      value !== null && typeof value === "object"
        ? Object.getPrototypeOf(value)
        : undefined;
    for (let depth = 0; proto && depth < 8; depth++) {
      const name = (proto as { constructor?: { name?: unknown } }).constructor
        ?.name;
      if (typeof name === "string" && Object.hasOwn(table, name))
        return table[name];
      proto = Object.getPrototypeOf(proto);
    }
  } catch {
    // An exotic object: unknown transport.
  }
  return undefined;
}

export function serverTransport(rpcContext: unknown): string | undefined {
  return transportByClass(rpcContext, CONTEXT_TRANSPORTS);
}

export function clientTransport(client: unknown): string | undefined {
  return transportByClass(client, CLIENT_TRANSPORTS);
}

/** `<transport> <pattern>`, or `rpc <pattern>` for a custom transport. */
export function spanName(
  transport: string | undefined,
  pattern: string,
): string {
  return `${transport ?? "rpc"} ${pattern}`;
}

// ---------------------------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------------------------

function sortedJson(value: unknown, depth: number): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => sortedJson(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortedJson((value as Record<string, unknown>)[key], depth + 1);
  }
  return out;
}

/**
 * A pattern as Nest routes it: a string as it is, anything else as JSON with its object keys
 * sorted (what `transformPatternToRoute` produces). Capped at 256 characters. Never throws.
 */
export function normalizePattern(pattern: unknown): string {
  let text: string;
  try {
    if (typeof pattern === "string") text = pattern;
    else if (typeof pattern === "number" || typeof pattern === "boolean")
      text = String(pattern);
    else text = JSON.stringify(sortedJson(pattern, 0)) ?? String(pattern);
  } catch {
    text = "(unserializable pattern)";
  }
  return text.length > MAX_PATTERN_LENGTH
    ? `${text.slice(0, MAX_PATTERN_LENGTH - 1)}…`
    : text;
}

// ---------------------------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------------------------

/**
 * The packet metadata of an RPC context: `getMetadata()`, which every built-in context has from
 * `@nestjs/microservices` 12.0.4 (TCP and Redis read it from the packet; NATS, Kafka, RabbitMQ and
 * MQTT 5 from the message headers; P4-S1 Q1). Anything that is not a plain object is ignored.
 */
export function readMetadata(rpcContext: unknown): object | undefined {
  if (rpcContext === null || typeof rpcContext !== "object") return undefined;
  const getMetadata = (rpcContext as { getMetadata?: unknown }).getMetadata;
  if (typeof getMetadata !== "function") return undefined;
  const metadata: unknown = getMetadata.call(rpcContext);
  return metadata !== null && typeof metadata === "object"
    ? metadata
    : undefined;
}

/**
 * Reads only string values (a Kafka header may arrive as a `Buffer`, decoded as UTF-8; anything
 * else is skipped). Metadata is client-controlled, so nothing else is trusted; the propagator
 * validates the format of what it reads.
 */
export const metadataGetter: TextMapGetter<object> = {
  keys(carrier) {
    try {
      return Object.keys(carrier);
    } catch {
      return [];
    }
  },
  get(carrier, key) {
    try {
      const value: unknown = (carrier as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
      if (value instanceof Uint8Array) return Buffer.from(value).toString();
      if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    } catch {
      // Unreadable entry.
    }
    return undefined;
  },
};
