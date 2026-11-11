import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Req,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { AlwaysRejectGuard } from "./always-reject.guard.js";
import { getStatusWithFetch, getStatusWithHttp } from "./out.js";
import { readUpload, type UploadRequest } from "./upload.js";

@Controller()
export class AppController {
  @Get("hello")
  hello(): string {
    return "hello";
  }

  @Get("users/:id")
  user(@Param("id") id: string): { id: string } {
    return { id };
  }

  /** Method-level guard, on a controller that has none. */
  @Get("private-method")
  @UseGuards(AlwaysRejectGuard)
  privateMethod(): string {
    return "unreachable";
  }

  @Get("boom")
  boom(): never {
    throw new Error("boom");
  }

  @Get("teapot")
  teapot(): never {
    throw new HttpException("I'm a teapot", 418);
  }

  /**
   * Four chunks, 250 ms apart. A `StreamableFile` wrapping a Node `Readable` is
   * piped by Nest's own adapter code, so the route is the same on Express, Fastify
   * and platform-node (no `res.write`, which differs between them).
   */
  @Get("stream")
  stream(): StreamableFile {
    async function* chunks() {
      for (let i = 1; i <= 4; i++) {
        await sleep(250);
        yield `chunk ${i}\n`;
      }
    }
    return new StreamableFile(Readable.from(chunks()), {
      type: "text/plain; charset=utf-8",
    });
  }

  @Post("echo")
  echo(@Body() body: unknown): unknown {
    return body;
  }

  @Post("upload")
  async upload(
    @Req() req: UploadRequest,
  ): Promise<{ name: string; size: number }> {
    return readUpload(req);
  }

  /** Outgoing calls: `fetch` (undici) and `node:http`, to `OUT_URL` or this app's `/hello`. */
  @Get("out")
  async out(): Promise<{ fetch: number; http: number }> {
    const url =
      process.env.OUT_URL ??
      `http://127.0.0.1:${process.env.PORT ?? 3000}/hello`;
    const [viaFetch, viaHttp] = await Promise.all([
      getStatusWithFetch(url),
      getStatusWithHttp(url),
    ]);
    return { fetch: viaFetch, http: viaHttp };
  }
}
