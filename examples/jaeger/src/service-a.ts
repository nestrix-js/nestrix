import "reflect-metadata";
import { Controller, Get, Module, Param } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestrixModule } from "@nestrix-js/nestjs";

const serviceBUrl = process.env.SERVICE_B_URL ?? "http://127.0.0.1:3002";

@Controller("call")
class CallController {
  @Get(":id")
  async call(@Param("id") id: string): Promise<unknown> {
    const res = await fetch(`${serviceBUrl}/items/${encodeURIComponent(id)}`);
    return { from: "service-a", upstream: await res.json() };
  }
}

// Export goes to OTEL_EXPORTER_OTLP_ENDPOINT.
@Module({
  imports: [NestrixModule.forRoot({ serviceName: "service-a" })],
  controllers: [CallController],
})
class ServiceAModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ServiceAModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001));
}

void bootstrap();
