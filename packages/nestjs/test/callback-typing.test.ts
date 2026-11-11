// Typecheck guard (D-69): `user` and `authorize` accept a callback whose parameter is typed, and a
// `redact` hook may be a named function that returns void. These fail `pnpm typecheck` if the
// option types go back to property-style signatures that demand `unknown`.
import { describe, expect, it } from "vitest";
import type { NestrixModuleOptions, RedactableSpan } from "../src/index.js";

function redact(span: RedactableSpan): void {
  delete span.attributes["url.query"];
}

const options: NestrixModuleOptions = {
  user: (req: { user?: { id: string } }) => req.user?.id,
  redact,
  ui: {
    enabled: true,
    auth: {
      authorize: (req: { headers: Record<string, string> }) =>
        req.headers.authorization === "x",
    },
  },
  methods: false,
};

describe("callback typing", () => {
  it("accepts typed callbacks", () => {
    expect(typeof options.user).toBe("function");
    expect(options.methods).toBe(false);
  });
});
