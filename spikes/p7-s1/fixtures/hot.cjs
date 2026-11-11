// CommonJS hot function. The probes check its line in a .cpuprofile (0-based: 2), so keep it on line 3.
// biome-ignore format: the line number is checked
function cjsHotLoop(ms) { const end = performance.now() + ms; let x = 0; while (performance.now() < end) { for (let i = 0; i < 1e4; i++) x += Math.sin(i); } return x; }
module.exports = { cjsHotLoop };
