import "reflect-metadata";
import { Controller, Get, Module, Param } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestrixModule } from "@nestrix/nestjs";

@Controller("items")
class ItemsController {
  @Get(":id")
  item(@Param("id") id: string): { id: string; name: string } {
    return { id, name: `item-${id}` };
  }
}

@Module({
  imports: [NestrixModule.forRoot({ serviceName: "service-b" })],
  controllers: [ItemsController],
})
class ServiceBModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ServiceBModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3002));
}

void bootstrap();
