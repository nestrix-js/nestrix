import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

class OutOfStockError extends Error {}

@Module({
  imports: [
    NestrixModule.forRoot({
      errors: {
        // Also expected: your own errors (subclasses too), by class, name or RegExp.
        expected: [OutOfStockError, "PaymentDeclinedError", /^Validation/],
        // or a function: (e) => (e instanceof ConflictException ? false : undefined)
        // or false: count every recorded exception, 4xx included
      },
    }),
  ],
})
export class AppModule {}
