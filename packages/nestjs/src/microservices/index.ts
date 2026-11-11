// Microservice tracing (backlog P4-01, spike P4-S1). Nothing here imports `@nestjs/microservices`.
export { instrumentClient } from "./client.js";
export { NestrixMicroservices } from "./installer.js";
export { interceptRpc, nestrixPreRequestHook } from "./server.js";
