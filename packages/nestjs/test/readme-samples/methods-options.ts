import { Injectable, Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

// Provided by your own dynamic module, so not traced unless included.
@Injectable()
export class PaymentsGateway {}

@Module({
  imports: [
    NestrixModule.forRoot({
      methods: {
        // A class, an exact name or a RegExp. Added to the app's own classes.
        include: [PaymentsGateway, /Client$/],
        // Never traced. Wins over `include`.
        exclude: ["HealthService"],
        // Guards, pipes, interceptors and filters. Default false; true is all four.
        enhancers: ["guard"],
      },
    }),
  ],
})
export class AppModule {}
