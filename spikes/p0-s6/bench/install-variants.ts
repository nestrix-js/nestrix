// Q6 follow-up: how to install n wrappers on an instance most cheaply. Run: `node bench/install-variants.ts`.
// Median of 7 runs after 3 warm-up runs, ns per `new C()` + install.
type Obj = Record<string, unknown> & { k: number };

function makeClass(n: number): new () => Obj {
  const C = new Function("return class X { constructor() { this.k = 1; } }")();
  for (let i = 0; i < n; i++) {
    Object.defineProperty(C.prototype, `m${i}`, {
      value: new Function(`return { m${i}(a) { return a + this.k; } }`)()[
        `m${i}`
      ],
      writable: true,
      configurable: true,
    });
  }
  return C;
}

let sink = 0;
function bench(
  label: string,
  n: number,
  install: (o: Obj) => Obj,
  C: new () => Obj = makeClass(n),
): void {
  const I = 20_000;
  for (let w = 0; w < 3; w++)
    for (let i = 0; i < I; i++) sink += install(new C()).k;
  const s: number[] = [];
  for (let r = 0; r < 7; r++) {
    const t = process.hrtime.bigint();
    for (let i = 0; i < I; i++) sink += install(new C()).k;
    s.push(Number(process.hrtime.bigint() - t) / I);
  }
  s.sort((a, b) => a - b);
  console.log(`| ${label} | ${n} | ${(s[3] as number).toFixed(1)} |`);
}

console.log(
  `Node ${process.version}\n\n| variant | methods | ns per instance |\n|---|---|---|`,
);
for (const n of [1, 10, 100]) {
  const names = Array.from({ length: n }, (_, i) => `m${i}`);
  const fns = names.map(() => () => 0);
  const descs: PropertyDescriptorMap = {};
  names.forEach((nm, i) => {
    descs[nm] = {
      value: fns[i],
      writable: true,
      configurable: true,
      enumerable: false,
    };
  });
  bench("none (new only)", n, (o) => o);
  bench("defineProperty loop", n, (o) => {
    for (let i = 0; i < n; i++)
      Object.defineProperty(
        o,
        names[i] as string,
        descs[names[i] as string] as PropertyDescriptor,
      );
    return o;
  });
  bench("defineProperties(cached map)", n, (o) =>
    Object.defineProperties(o, descs),
  );
  bench("plain assignment (enumerable, not acceptable)", n, (o) => {
    for (let i = 0; i < n; i++) o[names[i] as string] = fns[i];
    return o;
  });
  const C = makeClass(n);
  const D = Object.create(C.prototype);
  Object.defineProperties(D, descs);
  bench("setPrototypeOf(derived)", n, (o) => Object.setPrototypeOf(o, D), C);
}
console.log(`\n(sink ${sink > 0})`);
