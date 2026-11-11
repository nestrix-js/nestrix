import type { IncomingHttpHeaders } from "node:http";
import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

// Your own check, for example a verified session or an identity-aware proxy's signed header.
declare function isOperator(
  authorization: string | undefined,
): Promise<boolean>;

@Module({
  imports: [
    NestrixModule.forRoot({
      ui: {
        enabled: true,
        auth: {
          // `request` is the raw adapter request (Express `req`, Fastify `request`,
          // platform-node's request). No Nest guard has run, so `request.user` is not set.
          authorize: async (request) => {
            const { headers } = request as { headers: IncomingHttpHeaders };
            return isOperator(headers.authorization);
          },
        },
      },
    }),
  ],
})
export class AppModule {}
