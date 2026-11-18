import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

@Module({
  imports: [
    NestrixModule.forRoot({
      // Off unless set. `request` is what your guards get, after they ran.
      context: (request: {
        user?: { tenantId?: string; clientId?: string };
      }) => ({
        "tenant.id": request.user?.tenantId,
        "app.client_id": request.user?.clientId,
      }),
      // Carried to the jobs the request queues; the worker must list the same keys.
      contextPropagation: { keys: ["tenant.id"] },
    }),
  ],
})
export class AppModule {}
