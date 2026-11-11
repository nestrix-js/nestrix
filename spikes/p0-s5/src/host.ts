import {
  type ArgumentsHost,
  type CallHandler,
  type CanActivate,
  Catch,
  Controller,
  type DynamicModule,
  type ExceptionFilter,
  type ExecutionContext,
  Get,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestInterceptor,
  type NestMiddleware,
  type PipeTransform,
  RequestMethod,
  type Type,
} from "@nestjs/common";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  BaseExceptionFilter,
} from "@nestjs/core";
import { tap } from "rxjs";
import { DashboardModule, type MountOptions } from "./dashboard.js";

/** Counts of host enhancers that ran, read by the tests. */
export const hostSeen = {
  guard: 0,
  interceptor: 0,
  pipe: 0,
  filter: 0,
  middleware: 0,
  filterErrors: [] as string[],
};

export function resetHostSeen(): void {
  hostSeen.guard = 0;
  hostSeen.interceptor = 0;
  hostSeen.pipe = 0;
  hostSeen.filter = 0;
  hostSeen.middleware = 0;
  hostSeen.filterErrors = [];
}

@Controller()
export class HostController {
  @Get("hello")
  hello(): string {
    return "hello";
  }
}

/** A host catch-all route (Q3). Express and platform-node syntax. */
@Controller()
export class CatchAllController {
  @Get("*splat")
  all(): string {
    return "host-catch-all";
  }
}

/** The same on Fastify, whose router wants a bare trailing `*`. */
@Controller()
export class FastifyCatchAllController {
  @Get("*")
  all(): string {
    return "host-catch-all";
  }
}

@Injectable()
export class RejectAllGuard implements CanActivate {
  canActivate(): boolean {
    hostSeen.guard++;
    return false;
  }
}

@Injectable()
export class TagInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler) {
    hostSeen.interceptor++;
    return next.handle().pipe(tap(() => {}));
  }
}

@Injectable()
export class CountPipe implements PipeTransform {
  transform(value: unknown) {
    hostSeen.pipe++;
    return value;
  }
}

@Catch()
export class CountingFilter
  extends BaseExceptionFilter
  implements ExceptionFilter
{
  override catch(exception: unknown, host: ArgumentsHost) {
    hostSeen.filter++;
    hostSeen.filterErrors.push((exception as Error)?.message ?? "?");
    return super.catch(exception, host);
  }
}

@Injectable()
export class CountMiddleware implements NestMiddleware {
  use(_req: unknown, res: unknown, next: () => void) {
    hostSeen.middleware++;
    const raw = (res as { raw?: { setHeader: (k: string, v: string) => void } })
      .raw;
    (raw ?? (res as { setHeader: (k: string, v: string) => void })).setHeader(
      "x-host-consumer-middleware",
      "1",
    );
    next();
  }
}

export interface HostOptions {
  mount?: MountOptions;
  /** Order matters for lifecycle hooks; `dashboardFirst` puts DashboardModule ahead of `extraImports`. */
  extraImports?: (Type | DynamicModule)[];
  dashboardFirst?: boolean;
  catchAll?: boolean | "fastify";
  enhancers?: boolean;
  consumerMiddleware?: boolean;
}

/** Builds a fresh root module for one test. */
export function hostModule(opts: HostOptions = {}): Type {
  const dashboard = DashboardModule.register(
    opts.mount ?? { when: "init", strategy: "adapter" },
  );
  const extra = opts.extraImports ?? [];
  const imports =
    opts.dashboardFirst === false
      ? [...extra, dashboard]
      : [dashboard, ...extra];
  const controllers: Type[] = [HostController];
  if (opts.catchAll)
    controllers.push(
      opts.catchAll === "fastify"
        ? FastifyCatchAllController
        : CatchAllController,
    );
  const providers = opts.enhancers
    ? [
        { provide: APP_GUARD, useClass: RejectAllGuard },
        { provide: APP_INTERCEPTOR, useClass: TagInterceptor },
        { provide: APP_PIPE, useClass: CountPipe },
        { provide: APP_FILTER, useClass: CountingFilter },
      ]
    : [];

  @Module({ imports, controllers, providers })
  class HostAppModule {
    configure(consumer: MiddlewareConsumer) {
      if (opts.consumerMiddleware) {
        consumer
          .apply(CountMiddleware)
          .forRoutes({ path: "*splat", method: RequestMethod.ALL });
      }
    }
  }
  return HostAppModule;
}
