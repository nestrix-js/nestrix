#!/usr/bin/env node
// Regenerates src/proto/gen/ from a pinned opentelemetry-proto release with protoc-gen-es.
// Run from apps/server: `pnpm generate:proto`. The output is checked in; nothing runs this at build time.
//
// Inputs:
// - opentelemetry-proto at TAG, downloaded as the release tarball and checked against SHA256;
// - proto/google/rpc/status.proto, our wire-compatible subset of google.rpc.Status (the body
//   OTLP/HTTP uses for 4xx and 5xx responses).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TAG = "v1.11.1";
const SHA256 =
  "c0bdd2ff083665e0504a6574923ebe53c60c086ea11836c5aa543683f55a6c32";
const URL = `https://codeload.github.com/open-telemetry/opentelemetry-proto/tar.gz/refs/tags/${TAG}`;
const FILES = [
  "opentelemetry/proto/common/v1/common.proto",
  "opentelemetry/proto/resource/v1/resource.proto",
  "opentelemetry/proto/trace/v1/trace.proto",
  "opentelemetry/proto/collector/trace/v1/trace_service.proto",
  "opentelemetry/proto/logs/v1/logs.proto",
  "opentelemetry/proto/collector/logs/v1/logs_service.proto",
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "nestrix-proto-"));
try {
  const response = await fetch(URL);
  if (!response.ok) throw new Error(`GET ${URL}: ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(tarball).digest("hex");
  if (actual !== SHA256) {
    throw new Error(
      `opentelemetry-proto ${TAG}: SHA-256 ${actual}, expected ${SHA256}`,
    );
  }
  const archive = join(work, "proto.tgz");
  writeFileSync(archive, tarball);
  execFileSync("tar", ["xzf", archive, "-C", work]);
  const otelDir = join(work, `opentelemetry-proto-${TAG.slice(1)}`);

  // One staging directory holding exactly the files to generate, so buf sees one module.
  const staging = join(work, "staging");
  for (const file of FILES) {
    mkdirSync(dirname(join(staging, file)), { recursive: true });
    cpSync(join(otelDir, file), join(staging, file));
  }
  cpSync(join(root, "proto"), staging, { recursive: true });

  const template = {
    version: "v2",
    clean: true,
    plugins: [
      {
        local: "protoc-gen-es",
        out: "src/proto/gen",
        opt: ["target=ts", "import_extension=js"],
      },
    ],
  };
  execFileSync(
    "buf",
    ["generate", staging, "--template", JSON.stringify(template)],
    { cwd: root, stdio: "inherit" },
  );
  console.log(`generated src/proto/gen from opentelemetry-proto ${TAG}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
