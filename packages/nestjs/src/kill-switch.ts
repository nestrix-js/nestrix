// The `NESTRIX_ENABLED` kill switch, in a module of its own so the level 2 instance decorator can
// read it without loading the option resolver (D-99).

/** Whether `NESTRIX_ENABLED` switches Nestrix off. `false` and `0`, any case, do. */
export function isDisabledByEnv(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const value = env.NESTRIX_ENABLED?.trim().toLowerCase();
  return value === "false" || value === "0";
}
