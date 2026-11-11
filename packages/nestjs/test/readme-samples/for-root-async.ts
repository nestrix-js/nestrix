import { Injectable, Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

@Injectable()
class Settings {
  readonly otlpEndpoint = process.env.COLLECTOR_URL;
}

@Module({ providers: [Settings], exports: [Settings] })
class SettingsModule {}

@Module({
  imports: [
    NestrixModule.forRootAsync({
      imports: [SettingsModule],
      inject: [Settings],
      useFactory: (settings: Settings) => ({
        serviceName: "my-api",
        export: { otlp: { endpoint: settings.otlpEndpoint } },
      }),
    }),
  ],
})
export class AppModule {}
