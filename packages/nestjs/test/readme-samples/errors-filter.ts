import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { recordError } from "../../src/index.js";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
  ) {}

  catch(exception: unknown, args: ArgumentsHost): void {
    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;
    // Guards and middleware throw before Nestrix's interceptor: report 5xx here.
    if (status >= 500)
      recordError(exception, { "app.error_code": "E_INTERNAL" });
    const response = args.switchToHttp().getResponse();
    this.host.httpAdapter.reply(response, { statusCode: status }, status);
  }
}
