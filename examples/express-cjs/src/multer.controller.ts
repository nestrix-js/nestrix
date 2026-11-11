import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";

/** The fields used from multer's file object (no `@types/multer` needed). */
interface MulterFile {
  originalname: string;
  size: number;
}

/**
 * Express only: multipart parsed by Nest's multer `FileInterceptor`, so the body is
 * read in an interceptor between the request hook and the handler (spike P0-S1,
 * question 2). `POST /upload` on `AppController` parses in the handler instead, so
 * it runs on every adapter.
 */
@Controller()
export class MulterController {
  @Post("upload-multer")
  @UseInterceptors(FileInterceptor("file"))
  upload(@UploadedFile() file: MulterFile): {
    name: string;
    size: number;
  } {
    return { name: file.originalname, size: file.size };
  }
}
