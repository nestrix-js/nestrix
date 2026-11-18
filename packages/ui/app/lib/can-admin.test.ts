import { describe, expect, it } from "vitest";

import { canAdminOf } from "@/lib/can-admin";

describe("canAdminOf (issue #34)", () => {
  it("is false only for a viewer", () => {
    expect(canAdminOf({ access: { role: "viewer", kind: "oidc" } })).toBe(
      false,
    );
    expect(canAdminOf({ access: { role: "viewer", kind: "token" } })).toBe(
      false,
    );
    expect(canAdminOf({ access: { role: "admin", kind: "password" } })).toBe(
      true,
    );
  });

  it("treats a backend without roles (embedded, older servers) as admin", () => {
    expect(canAdminOf({})).toBe(true);
  });
});
