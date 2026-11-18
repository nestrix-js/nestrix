import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import {
  ERROR_SYNC_OPTIONS,
  ErrorGroupSync,
  type ErrorSyncOptions,
} from "./sync.js";

/** Starts the sync with the application and stops it at shutdown. */
@Injectable()
export class ErrorGroupSyncLifecycle
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(
    @Inject(ErrorGroupSync) private readonly sync: ErrorGroupSync,
    @Inject(ERROR_SYNC_OPTIONS) private readonly options: ErrorSyncOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.schedule !== false) this.sync.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.sync.stop();
  }
}
