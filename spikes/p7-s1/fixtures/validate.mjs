// Structural checks on a V8 CPU profile (the Chrome DevTools `.cpuprofile` format), and helpers to
// find a function in it. Returns a list of problems (empty when valid) rather than throwing, so a
// probe can report everything at once.

export function validateProfile(profile) {
  const problems = [];
  for (const key of [
    "nodes",
    "startTime",
    "endTime",
    "samples",
    "timeDeltas",
  ]) {
    if (!(key in profile)) problems.push(`missing ${key}`);
  }
  if (problems.length) return problems;
  if (!Array.isArray(profile.nodes) || profile.nodes.length === 0)
    problems.push("no nodes");
  if (profile.samples.length !== profile.timeDeltas.length)
    problems.push(
      `samples ${profile.samples.length} != timeDeltas ${profile.timeDeltas.length}`,
    );
  const ids = new Set(profile.nodes.map((n) => n.id));
  if (ids.size !== profile.nodes.length) problems.push("duplicate node ids");
  for (const n of profile.nodes) {
    if (!n.callFrame || typeof n.callFrame.functionName !== "string")
      problems.push(`node ${n.id} has no callFrame`);
    for (const c of n.children ?? [])
      if (!ids.has(c)) problems.push(`node ${n.id} child ${c} missing`);
  }
  for (const s of profile.samples) {
    if (!ids.has(s)) {
      problems.push(`sample refers to missing node ${s}`);
      break;
    }
  }
  if (profile.nodes[0]?.callFrame?.functionName !== "(root)")
    problems.push("first node is not (root)");
  const sum = profile.timeDeltas.reduce((a, b) => a + b, 0);
  const span = profile.endTime - profile.startTime;
  // The first delta is measured from startTime, so the sum stays within the profile's span.
  if (sum > span + 1000) problems.push(`timeDeltas sum ${sum} > span ${span}`);
  return problems;
}

/** Self samples per node id. */
export function selfCounts(profile) {
  const counts = new Map();
  for (const s of profile.samples) counts.set(s, (counts.get(s) ?? 0) + 1);
  return counts;
}

/** Nodes for a function name, with their call frame and their self-sample share. */
export function findFunction(profile, name) {
  const counts = selfCounts(profile);
  const total = profile.samples.length || 1;
  const nodes = profile.nodes.filter((n) => n.callFrame.functionName === name);
  const self = nodes.reduce((a, n) => a + (counts.get(n.id) ?? 0), 0);
  return {
    found: nodes.length > 0,
    url: nodes[0]?.callFrame.url,
    lineNumber: nodes[0]?.callFrame.lineNumber,
    columnNumber: nodes[0]?.callFrame.columnNumber,
    selfShare: self / total,
    scriptIdType: typeof nodes[0]?.callFrame.scriptId,
    hasPositionTicks: nodes.some(
      (n) => Array.isArray(n.positionTicks) && n.positionTicks.length > 0,
    ),
  };
}

/** Top functions by self samples, as the dashboard's table would show them. */
export function topFunctions(profile, limit = 5) {
  const counts = selfCounts(profile);
  const byFn = new Map();
  for (const n of profile.nodes) {
    const key = `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url}:${n.callFrame.lineNumber + 1}`;
    byFn.set(key, (byFn.get(key) ?? 0) + (counts.get(n.id) ?? 0));
  }
  const total = profile.samples.length || 1;
  return [...byFn.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v]) => `${k} ${((100 * v) / total).toFixed(1)}%`);
}

/**
 * Median sample interval in microseconds, after the start burst. The first capture in a process
 * begins with about 100 samples some 20 us apart (seen with all three APIs; later captures in the
 * same process do not have it), so after the first two deltas (the start itself) the deltas under
 * 500 us are skipped.
 */
export function medianDelta(profile) {
  const all = profile.timeDeltas;
  let i = 2; // the first two deltas cover the start itself
  while (i < all.length && all[i] < 500) i++;
  const d = all.slice(i).sort((a, b) => a - b);
  return d.length ? d[d.length >> 1] : Number.NaN;
}
