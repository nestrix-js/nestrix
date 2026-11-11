import type { Type } from "@nestjs/common";
import type { AdapterName } from "./boot.js";
import { buildSpikeModule, type SpikeModuleOptions } from "./probe-app.js";

/**
 * The fixture app for `adapter` with the hooks module and the probes imported:
 * the fixture `ExpressAppModule` (AppModule + multer route) on Express, the
 * fixture `AppModule` elsewhere.
 */
export async function spikeAppFor(
  adapter: AdapterName,
  options: Omit<SpikeModuleOptions, "app"> = {},
): Promise<Type> {
  if (adapter === "express") {
    const { ExpressAppModule } = await import("express-esm/express-app.module");
    const { ExpressProbeController } = await import("./express-probe.js");
    return buildSpikeModule({
      ...options,
      app: ExpressAppModule,
      controllers: [...(options.controllers ?? []), ExpressProbeController],
    });
  }
  const { AppModule } = await import("express-esm/app.module");
  const extra: Type[] = [];
  if (adapter === "node") {
    const { NodeProbeController } = await import("./node-probe.js");
    extra.push(NodeProbeController);
  }
  return buildSpikeModule({
    ...options,
    app: AppModule,
    controllers: [...(options.controllers ?? []), ...extra],
  });
}

/** Points recorded for one request, as `point -> storeProbe`, in order. */
export function summarise(
  list: { point: string; probe?: string; storeProbe?: string }[],
): string[] {
  return list.map(
    (o) =>
      `${o.point}${o.probe ? `[${o.probe}]` : ""} -> ${o.storeProbe ?? "NO STORE"}`,
  );
}
