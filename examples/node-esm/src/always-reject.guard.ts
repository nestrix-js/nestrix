import { type CanActivate, Injectable } from "@nestjs/common";

/** Always denies. Nest turns `false` into a 403 Forbidden. */
@Injectable()
export class AlwaysRejectGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}
