import type { ProfileDetail } from "@nestrix-js/protocol";
import { clean, fmtMs, fmtPct } from "./format.js";

export const PROFILE_TOP = 15;

/** `file:///app/dist/x.js` as `/app/dist/x.js`, cut from the left to at most 90 characters. */
function place(url: string, line: number): string {
  if (url === "") return "(runtime)";
  let path = clean(
    url.startsWith("file://") ? decodeSafe(url.slice(7)) : url,
    400,
  );
  const dependency = path.lastIndexOf("/node_modules/");
  if (dependency >= 0) path = path.slice(dependency + 1);
  const shortened =
    path.length > 90 ? `…${path.slice(path.length - 89)}` : path;
  return line > 0 ? `${shortened}:${line}` : shortened;
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The hottest functions of a finished capture, by self time. */
export function renderProfile(detail: ProfileDetail): string {
  // The flame root's total excludes (idle): the share is of the time the process was working.
  const busy = detail.flame.totalSamples;
  const lines = [
    `CPU profile ${clean(detail.id, 64)}: ${fmtMs(detail.actualDurationMs)} captured, ${detail.samples} samples (${busy} not idle), starting it paused the app for ${fmtMs(detail.startPauseMs)}.`,
  ];
  if (detail.topFunctions.length === 0 || busy === 0) {
    lines.push(
      "The process was idle for the whole capture: nothing ran. Send the traffic you want to profile while the capture runs.",
    );
    return lines.join("\n");
  }
  lines.push("Top functions by self time (share of non-idle samples):");
  detail.topFunctions.slice(0, PROFILE_TOP).forEach((f, i) => {
    lines.push(
      `${i + 1}. ${fmtPct(f.selfSamples, busy)} ${clean(f.functionName, 100)} ${place(f.url, f.line)} (self ${f.selfSamples} samples, with callees ${f.totalSamples})`,
    );
  });
  if (detail.topFunctions.length > PROFILE_TOP) {
    lines.push(
      `... ${detail.topFunctions.length - PROFILE_TOP} more functions not shown.`,
    );
  }
  lines.push(
    "(program) is native work outside JavaScript and (garbage collector) is GC. Line numbers are of the running JavaScript, without source maps.",
  );
  return lines.join("\n");
}
