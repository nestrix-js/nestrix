/** Stand-in for `@nestjs/platform-node`, which was first published in 12.3.0. */
export class NodeAdapter {
  constructor() {
    throw new Error("@nestjs/platform-node does not exist in Nest 12.0.0");
  }
}
