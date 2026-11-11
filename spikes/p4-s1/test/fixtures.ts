import "reflect-metadata";
import { createServer } from "node:net";
import {
  type CanActivate,
  Controller,
  type DynamicModule,
  Get,
  Inject,
  Injectable,
  Module,
  UseGuards,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import {
  type ClientProxy,
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
} from "@nestjs/microservices";
import { trace } from "@opentelemetry/api";
import { firstValueFrom, of } from "rxjs";
import { ProbeInterceptor } from "./harness.ts";

export const handled: Array<{
  pattern: string;
  metadata: unknown;
  activeTraceId: string | undefined;
  activeSpanId: string | undefined;
  ctxClass: string;
  extra?: unknown;
}> = [];

function record(pattern: string, ctx: unknown, extra?: unknown): void {
  const getMetadata = (ctx as { getMetadata?: () => unknown }).getMetadata;
  const sc = trace.getActiveSpan()?.spanContext();
  handled.push({
    pattern,
    metadata: typeof getMetadata === "function" ? getMetadata.call(ctx) : null,
    activeTraceId: sc?.traceId,
    activeSpanId: sc?.spanId,
    ctxClass: (ctx as object).constructor.name,
    extra: extra ?? ctx,
  });
}

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Controller()
export class RpcController {
  @MessagePattern("sum")
  sum(@Payload() data: number[], @Ctx() ctx: unknown): number {
    record("sum", ctx);
    return data.reduce((a, b) => a + b, 0);
  }

  @MessagePattern("stream")
  stream(@Ctx() ctx: unknown) {
    record("stream", ctx);
    return of(1, 2, 3);
  }

  @MessagePattern("fail")
  fail(@Ctx() ctx: unknown): number {
    record("fail", ctx);
    throw new Error("handler failed");
  }

  @MessagePattern("slow")
  async slow(@Ctx() ctx: unknown): Promise<string> {
    record("slow", ctx);
    await new Promise((r) => setTimeout(r, 200));
    return "late";
  }

  @UseGuards(DenyGuard)
  @MessagePattern("guarded")
  guarded(@Ctx() ctx: unknown): string {
    record("guarded", ctx);
    return "never";
  }

  @EventPattern("evt")
  evt(@Payload() _data: unknown, @Ctx() ctx: unknown): void {
    record("evt", ctx);
  }
}

@Controller()
export class HttpController {
  constructor(@Inject("CLIENT") private readonly client: ClientProxy) {}
  @Get("call")
  async call(): Promise<unknown> {
    return firstValueFrom(this.client.send("sum", [1, 2]));
  }
}

/** Like NestrixModule: a global dynamic module that registers an APP_INTERCEPTOR. */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static `forRoot`.
export class ProbeModule {
  static forRoot(interceptor: unknown = ProbeInterceptor): DynamicModule {
    return {
      module: ProbeModule,
      global: true,
      providers: [{ provide: APP_INTERCEPTOR, useClass: interceptor as never }],
    };
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}
