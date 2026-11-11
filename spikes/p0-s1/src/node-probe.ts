import {
  Controller,
  Headers,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-node";
import { record } from "./probe.js";

interface MulterFile {
  originalname: string;
  size: number;
}

/** platform-node only: its own multer `FileInterceptor` parses the body between the hook and the handler. */
@Controller("probe")
export class NodeProbeController {
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
