/**
 * Blue-noise tile generator (Ulichney's void-and-cluster, 1993).
 *
 * Produces a 64x64 tile of ranks in [0, 4095], normalized to 8-bit, whose
 * thresholds are spectrally "blue" (energy concentrated at high frequencies) so
 * that using it as an ordered-dither source hides 8-bit banding far better than
 * white noise. Deterministic (seeded) so the baked output is reproducible.
 *
 * Run:  node packages/webgpu/tools/generate-blue-noise.mjs
 * It prints the base64 of the 4096-byte tile and a uniformity histogram check.
 * Paste the base64 into packages/webgpu/src/lib/blue-noise.ts.
 */

const N = 64;
const COUNT = N * N;
const SIGMA = 1.9; // energy spread of the Gaussian used to measure clustering

// Deterministic PRNG (mulberry32) so the tile never changes between runs.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x1234567);

// Precompute the (toroidal) Gaussian kernel.
const R = Math.ceil(SIGMA * 3);
const kernel = [];
for (let dy = -R; dy <= R; dy++) {
  for (let dx = -R; dx <= R; dx++) {
    const w = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA));
    if (w > 1e-4) kernel.push([dx, dy, w]);
  }
}

const energy = new Float64Array(COUNT);
const pattern = new Uint8Array(COUNT);
const wrap = (v) => ((v % N) + N) % N;
const at = (x, y) => wrap(y) * N + wrap(x);

function addPoint(p) {
  const x = p % N;
  const y = (p / N) | 0;
  for (const [dx, dy, w] of kernel) energy[at(x + dx, y + dy)] += w;
  pattern[p] = 1;
}
function removePoint(p) {
  const x = p % N;
  const y = (p / N) | 0;
  for (const [dx, dy, w] of kernel) energy[at(x + dx, y + dy)] -= w;
  pattern[p] = 0;
}
function tightestCluster() {
  let best = -1;
  let bv = -Infinity;
  for (let i = 0; i < COUNT; i++) {
    if (pattern[i] && energy[i] > bv) {
      bv = energy[i];
      best = i;
    }
  }
  return best;
}
function largestVoid() {
  let best = -1;
  let bv = Infinity;
  for (let i = 0; i < COUNT; i++) {
    if (!pattern[i] && energy[i] < bv) {
      bv = energy[i];
      best = i;
    }
  }
  return best;
}

// Initial pattern: ~10% ones placed at random.
let ones = 0;
const target = Math.round(COUNT * 0.1);
while (ones < target) {
  const p = (rand() * COUNT) | 0;
  if (!pattern[p]) {
    addPoint(p);
    ones++;
  }
}

// Phase 1 — reorder the prototype until swapping cluster<->void is a no-op.
for (;;) {
  const c = tightestCluster();
  removePoint(c);
  const v = largestVoid();
  addPoint(v);
  if (v === c) break;
}

const proto = pattern.slice();
const protoEnergy = energy.slice();
const dither = new Int32Array(COUNT).fill(-1);

// Phase 2 — remove the prototype's ones, assigning ranks [ones-1 .. 0].
for (let rank = ones - 1; rank >= 0; rank--) {
  const c = tightestCluster();
  dither[c] = rank;
  removePoint(c);
}

// Restore the prototype, then Phase 3 — fill voids, ranks [ones .. COUNT-1].
pattern.set(proto);
energy.set(protoEnergy);
for (let rank = ones; rank < COUNT; rank++) {
  const v = largestVoid();
  dither[v] = rank;
  addPoint(v);
}

// Normalize ranks to 8-bit.
const out = new Uint8Array(COUNT);
for (let i = 0; i < COUNT; i++) {
  out[i] = Math.min(255, Math.floor(((dither[i] + 0.5) / COUNT) * 256));
}

// Sanity: the value histogram must be ~uniform (each 8-bit level ~16 times).
const hist = new Array(256).fill(0);
for (const v of out) hist[v]++;
const counts = hist.filter((_, i) => i < 256);
const min = Math.min(...counts);
const max = Math.max(...counts);

console.error(`uniformity: min=${min} max=${max} (ideal 16 each)`);
if (dither.some((r) => r < 0)) throw new Error('unassigned rank');
console.log(Buffer.from(out).toString('base64'));
