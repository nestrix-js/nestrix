import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

@Module({
  imports: [
    NestrixModule.forRoot({
      // The release shown in the dashboard. Without it Nestrix reads GIT_SHA, then npm_package_version.
      serviceVersion: process.env.GIT_SHA,
      // Off unless set. `request` is what your guards get; a guard sets `request.user`.
      user: (request: { user?: { id?: string } }) => request.user?.id,
    }),
  ],
})
export class AppModule {}
