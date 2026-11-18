import { Module } from "@nestjs/common";
import { HealthService } from "./health.js";

/** `/livez` and `/readyz` (issue #32). The routes are a middleware, mounted by `configureApp`. */
@Module({ providers: [HealthService], exports: [HealthService] })
export class HealthModule {}
