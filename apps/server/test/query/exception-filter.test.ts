// The filter's status to code mapping: 401 and 503 have their own codes (P6-04).
import {
  type ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { QueryExceptionFilter } from "../../src/query/exception.filter.js";

function run(exception: unknown): { status: number; code: string } {
  let status = 0;
  let body: { error: { code: string } } | undefined;
  const res = {
    setHeader() {},
    status(code: number) {
      status = code;
      return {
        json(b: unknown) {
          body = b as { error: { code: string } };
        },
      };
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
  new QueryExceptionFilter().catch(exception, host);
  return { status, code: body?.error.code ?? "" };
}

describe("QueryExceptionFilter codes", () => {
  it.each([
    [new BadRequestException("x"), 400, "bad_request"],
    [new UnauthorizedException("x"), 401, "unauthorized"],
    [new ForbiddenException("x"), 403, "forbidden"],
    [new NotFoundException("x"), 404, "not_found"],
    [new ServiceUnavailableException("x"), 503, "unavailable"],
    [new HttpException("x", 500), 500, "internal"],
  ])("%s", (exception, status, code) => {
    expect(run(exception)).toEqual({ status, code });
  });
});
