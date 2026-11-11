/**
 * Alerting in the standalone server (docs/backlog/phase-7.md, P7-03): rules over the route
 * rollups, a once-a-minute evaluator, signed webhooks, and the admin API `/api/v1/alerts`.
 * Needs `StorageModule` (global: `STORAGE_POOL`) and the server config.
 */
import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { Pool } from "pg";
import type { ServerConfig } from "../config.js";
import { SERVER_CONFIG } from "../config.module.js";
import { STORAGE_POOL } from "../storage/storage.module.js";
import { AlertsController } from "./alerts.controller.js";
import { AlertsService } from "./alerts.service.js";
import { AlertEvaluator } from "./evaluator.js";
import {
  ALERTS_OPTIONS,
  type AlertsModuleOptions,
  type ResolvedAlertsOptions,
} from "./tokens.js";
import { WebhookSender } from "./webhook.js";

@Injectable()
class AlertsLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(AlertEvaluator) private readonly evaluator: AlertEvaluator,
    @Inject(WebhookSender) private readonly sender: WebhookSender,
    @Inject(ALERTS_OPTIONS) private readonly options: ResolvedAlertsOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.schedule !== false) this.evaluator.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.evaluator.stop();
    await this.sender.close(10_000);
  }
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static `forRoot`.
export class AlertsModule {
  static forRoot(options: AlertsModuleOptions = {}): DynamicModule {
    const logger = new Logger("NestrixAlerts");
    return {
      module: AlertsModule,
      controllers: [AlertsController],
      providers: [
        {
          provide: ALERTS_OPTIONS,
          inject: [SERVER_CONFIG],
          useFactory: (config: ServerConfig): ResolvedAlertsOptions => ({
            ...options,
            publicUrl: config.alerts.publicUrl,
            allowedHosts: config.alerts.allowedHosts,
            retentionDays: config.retentionDays,
          }),
        },
        {
          provide: WebhookSender,
          inject: [ALERTS_OPTIONS],
          useFactory: (o: ResolvedAlertsOptions) =>
            new WebhookSender({ allowedHosts: o.allowedHosts, ...o.webhook }),
        },
        {
          provide: AlertEvaluator,
          inject: [STORAGE_POOL, WebhookSender, ALERTS_OPTIONS],
          useFactory: (
            pool: Pool,
            sender: WebhookSender,
            o: ResolvedAlertsOptions,
          ) =>
            new AlertEvaluator(pool, sender, {
              retentionDays: o.retentionDays,
              publicUrl: o.publicUrl,
              ...(o.intervalMs !== undefined
                ? { intervalMs: o.intervalMs }
                : {}),
              ...(o.initialDelayMs !== undefined
                ? { initialDelayMs: o.initialDelayMs }
                : {}),
              onError: (message) => logger.warn(message),
            }),
        },
        AlertsService,
        AlertsLifecycle,
      ],
      exports: [AlertEvaluator, WebhookSender],
    };
  }
}
