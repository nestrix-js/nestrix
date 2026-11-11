import {
  Controller,
  Headers,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { record } from "./probe.js";

interface MulterFile {
  originalname: string;
  size: number;
}

/** Express only: multer parses the body in an interceptor, between the hook and the handler. */
@Controller("probe")
export class ExpressProbeController {
  @Post("upload-multer")
  @UseInterceptors(FileInterceptor("file"))
  upload(
    @UploadedFile() file: MulterFile,
    @Headers("x-probe") probe: string,
  ): { name: string; size: number } {
    record("handler", probe);
    return { name: file.originalname, size: file.size };
  }
}
