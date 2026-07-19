/**
 * Minimal WebGPU renderer — device + colour-correct present, now drawing a
 * render list of quads (ADR 0002/0003).
 *
 * The scene is composited in a linear-light `rgba16float` target: the target is
 * cleared to a background colour, the render list's quads are drawn instanced
 * (premultiplied `over`), and a present pass encodes the target to the display
 * (sRGB transfer, shared by Display-P3) with optional dither. Geometry comes
 * from `@rendera/core`'s pure render list; this backend just uploads and draws
 * it. Tiling, real fills, and blend modes are later slices.
 */

import { blendModeIndex, type RenderCommand } from '@rendera/core';
import { blueNoiseTile, BLUE_NOISE_SIZE } from './blue-noise';

/** A decoded image source the renderer can upload (browser image types). */
export type ImageSource = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

/** GPU resources for the textured-image and mip-generation pipelines. */
interface ImageResources {
  pipeline: GPURenderPipeline;
  texLayout: GPUBindGroupLayout;
  sampler: GPUSampler;
  mipPipeline: GPURenderPipeline;
  mipLayout: GPUBindGroupLayout;
  mipSampler: GPUSampler;
}

interface CachedImage {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
}

/** GPU resources for the backdrop-read blend/composite pass. */
interface CompositorResources {
  pipeline: GPURenderPipeline;
  layout: GPUBindGroupLayout;
}

/** GPU resources for the analytic vector-fill pass. */
interface PathResources {
  pipeline: GPURenderPipeline;
  layout: GPUBindGroupLayout;
  /** Viewport uniform bound for BOTH stages (the fragment reads the scale). */
  viewportBindGroup: GPUBindGroup;
}

/** Per-path-draw packing: its params slot and row-band table location. */
interface PathDraw {
  slot: number;
  bandTableOffset: number;
  bandCount: number;
  bandMinY: number;
  bandH: number;
}

/** A layer target on the compositing stack, with the group's compositing props. */
interface StackEntry {
  tex: GPUTexture;
  opacity: number;
  mode: number;
}

export interface RendererColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface WebGpuRendererOptions {
  colorSpace?: PredefinedColorSpace;
  dither?: boolean;
  /**
   * Supersampling factor: the scene is rendered into a target this many times
   * larger than the display in each axis, then box-filtered down at present for
   * anti-aliased edges. Default 2 (4 samples/px). Clamped down only if the
   * target would exceed the device's `maxTextureDimension2D`.
   */
  supersample?: number;
}

export interface ReadbackResult {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  format: GPUTextureFormat;
  bytesPerRow: number;
}

const QUAD_SHADER = /* wgsl */ `
struct Viewport { size : vec2f, _pad : vec2f };
@group(0) @binding(0) var<uniform> vp : Viewport;

struct VOut { @builtin(position) pos : vec4f, @location(0) color : vec4f };

@vertex fn vs(
  @location(0) corner : vec2f,
  @location(1) m0 : vec2f,
  @location(2) m1 : vec2f,
  @location(3) m2 : vec2f,
  @location(4) color : vec4f
) -> VOut {
  let screen = m0 * corner.x + m1 * corner.y + m2;
  let clip = vec2f(screen.x / vp.size.x * 2.0 - 1.0, 1.0 - screen.y / vp.size.y * 2.0);
  var out : VOut;
  out.pos = vec4f(clip, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment fn fs(@location(0) color : vec4f) -> @location(0) vec4f {
  return vec4f(color.rgb * color.a, color.a); // premultiplied linear
}
`;

const PRESENT_SHADER = /* wgsl */ `
@group(0) @binding(0) var sceneTex : texture_2d<f32>;
struct Params { dither : f32, scale : f32, _p1 : f32, _p2 : f32 };
@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(2) var noiseTex : texture_2d<f32>; // 64x64 blue-noise tile

@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[i], 0.0, 1.0);
}

fn linear_to_srgb(c : f32) -> f32 {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055;
  return select(hi, lo, c <= 0.0031308);
}

@fragment fn fs(@builtin(position) frag : vec4f) -> @location(0) vec4f {
  // Box-filter the supersampled scene down to this display pixel. The scene is
  // linear-light premultiplied, so a plain average is the correct resolve;
  // the sRGB encode and dither happen once, afterwards.
  let s = max(1, i32(params.scale));
  let base = vec2i(frag.xy) * s;
  var acc = vec4f(0.0);
  for (var dy = 0; dy < s; dy = dy + 1) {
    for (var dx = 0; dx < s; dx = dx + 1) {
      acc = acc + textureLoad(sceneTex, base + vec2i(dx, dy), 0);
    }
  }
  let lin = acc / f32(s * s);
  var rgb = vec3f(linear_to_srgb(lin.r), linear_to_srgb(lin.g), linear_to_srgb(lin.b));
  // Blue-noise ordered dither (tile wraps every 64 display px), applied once in
  // the display domain so 8-bit quantization does not band smooth gradients.
  let noise = textureLoad(noiseTex, vec2i(frag.xy) % vec2i(64, 64), 0).r;
  rgb = rgb + vec3f((noise - 0.5) / 255.0 * params.dither);
  return vec4f(rgb, lin.a);
}
`;

// Textured-quad pipeline. Samples an sRGB-view texture (hardware decodes to
// linear), so mip generation and filtering all happen in linear light. Output
// is premultiplied linear for the `over` blend into the scene target.
const IMAGE_SHADER = /* wgsl */ `
struct Viewport { size : vec2f, _pad : vec2f };
@group(0) @binding(0) var<uniform> vp : Viewport;
@group(1) @binding(0) var tex : texture_2d<f32>;
@group(1) @binding(1) var samp : sampler;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
  @location(1) opacity : f32,
};

@vertex fn vs(
  @location(0) corner : vec2f,
  @location(1) m0 : vec2f,
  @location(2) m1 : vec2f,
  @location(3) m2 : vec2f,
  @location(4) opacity : f32
) -> VOut {
  let screen = m0 * corner.x + m1 * corner.y + m2;
  let clip = vec2f(screen.x / vp.size.x * 2.0 - 1.0, 1.0 - screen.y / vp.size.y * 2.0);
  var out : VOut;
  out.pos = vec4f(clip, 0.0, 1.0);
  out.uv = corner;
  out.opacity = opacity;
  return out;
}

// Catmull-Rom cubic weights for a fractional offset in [0,1].
fn cubic(t : f32) -> vec4f {
  let t2 = t * t;
  let t3 = t2 * t;
  return 0.5 * vec4f(
    -t3 + 2.0 * t2 - t,
    3.0 * t3 - 5.0 * t2 + 2.0,
    -3.0 * t3 + 4.0 * t2 + t,
    t3 - t2
  );
}

// Bicubic (Catmull-Rom) magnification: 16 taps around the sample point, giving
// smooth-yet-sharp upscaling instead of blocky bilinear. Used when magnifying;
// minification falls through to the hardware sampler's mip/anisotropic path.
fn sampleBicubic(uv : vec2f) -> vec4f {
  let dims = vec2f(textureDimensions(tex, 0));
  let coord = uv * dims - 0.5;
  let f = fract(coord);
  let base = floor(coord);
  let wx = cubic(f.x);
  let wy = cubic(f.y);
  var acc = vec4f(0.0);
  for (var j = 0; j < 4; j = j + 1) {
    var row = vec4f(0.0);
    for (var i = 0; i < 4; i = i + 1) {
      let p = (base + vec2f(f32(i) - 1.0, f32(j) - 1.0) + 0.5) / dims;
      row = row + textureSampleLevel(tex, samp, p, 0.0) * wx[i];
    }
    acc = acc + row * wy[j];
  }
  return acc;
}

@fragment fn fs(@location(0) uv : vec2f, @location(1) opacity : f32) -> @location(0) vec4f {
  // Both samples are computed in uniform control flow (textureSample needs
  // implicit derivatives), then selected by the screen-space texel footprint:
  // < 1 texel/pixel means magnifying -> bicubic; otherwise the hardware
  // trilinear + anisotropic sample handles minification cleanly.
  let dims = vec2f(textureDimensions(tex, 0));
  let footprint = max(length(dpdx(uv * dims)), length(dpdy(uv * dims)));
  let hw = textureSample(tex, samp, uv);
  let bicubic = sampleBicubic(uv);
  let c = select(hw, bicubic, footprint < 1.0);
  let a = clamp(c.a, 0.0, 1.0) * opacity;
  return vec4f(c.rgb * a, a); // premultiplied linear
}
`;

// Mip-generation blit: box-downsample the previous level with a linear sampler.
// Both views are sRGB, so the average is computed in linear light.
const MIP_SHADER = /* wgsl */ `
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var samp : sampler;

struct VOut { @builtin(position) pos : vec4f, @location(0) uv : vec2f };

@vertex fn vs(@builtin(vertex_index) i : u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out : VOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  out.uv = vec2f((p[i].x + 1.0) * 0.5, 1.0 - (p[i].y + 1.0) * 0.5);
  return out;
}

@fragment fn fs(@location(0) uv : vec2f) -> @location(0) vec4f {
  return textureSample(src, samp, uv);
}
`;

// Backdrop-read compositor: blend a source layer over the running composite per
// W3C Compositing-1, in linear premultiplied light. Full-screen pass that
// ping-pongs into a fresh target. `mode` indexes @rendera/core's BLEND_MODES.
const BLEND_SHADER = /* wgsl */ `
@group(0) @binding(0) var backdropTex : texture_2d<f32>;
@group(0) @binding(1) var sourceTex : texture_2d<f32>;
struct Blend { mode : f32, opacity : f32, _p0 : f32, _p1 : f32 };
@group(0) @binding(2) var<uniform> bp : Blend;

@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn lum(c : vec3f) -> f32 { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }
fn sat3(c : vec3f) -> f32 { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
fn clipColor(c : vec3f) -> vec3f {
  let l = lum(c);
  let n = min(min(c.r, c.g), c.b);
  let x = max(max(c.r, c.g), c.b);
  var col = c;
  if (n < 0.0) { col = l + (col - l) * (l / (l - n)); }
  if (x > 1.0) { col = l + (col - l) * ((1.0 - l) / (x - l)); }
  return col;
}
fn setLum(c : vec3f, l : f32) -> vec3f { return clipColor(c + vec3f(l - lum(c))); }
fn setSat(c : vec3f, s : f32) -> vec3f {
  let mn = min(min(c.r, c.g), c.b);
  let mx = max(max(c.r, c.g), c.b);
  if (mx > mn) { return (c - mn) / (mx - mn) * s; }
  return vec3f(0.0);
}

fn sep(mode : i32, cb : f32, cs : f32) -> f32 {
  switch mode {
    case 1: { return cb * cs; }
    case 2: { return cb + cs - cb * cs; }
    case 3: { if (cb <= 0.5) { return 2.0 * cb * cs; } return 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs); }
    case 4: { return min(cb, cs); }
    case 5: { return max(cb, cs); }
    case 6: { if (cb <= 0.0) { return 0.0; } if (cs >= 1.0) { return 1.0; } return min(1.0, cb / (1.0 - cs)); }
    case 7: { if (cb >= 1.0) { return 1.0; } if (cs <= 0.0) { return 0.0; } return 1.0 - min(1.0, (1.0 - cb) / cs); }
    case 8: { if (cs <= 0.5) { return 2.0 * cb * cs; } return 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs); }
    case 9: {
      if (cs <= 0.5) { return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb); }
      var d : f32;
      if (cb <= 0.25) { d = ((16.0 * cb - 12.0) * cb + 4.0) * cb; } else { d = sqrt(cb); }
      return cb + (2.0 * cs - 1.0) * (d - cb);
    }
    case 10: { return abs(cb - cs); }
    case 11: { return cb + cs - 2.0 * cb * cs; }
    default: { return cs; }
  }
}

fn blendColor(mode : i32, Cb : vec3f, Cs : vec3f) -> vec3f {
  switch mode {
    case 12: { return setLum(setSat(Cs, sat3(Cb)), lum(Cb)); }
    case 13: { return setLum(setSat(Cb, sat3(Cs)), lum(Cb)); }
    case 14: { return setLum(Cs, lum(Cb)); }
    case 15: { return setLum(Cb, lum(Cs)); }
    default: { return vec3f(sep(mode, Cb.r, Cs.r), sep(mode, Cb.g, Cs.g), sep(mode, Cb.b, Cs.b)); }
  }
}

@fragment fn fs(@builtin(position) frag : vec4f) -> @location(0) vec4f {
  let coord = vec2i(frag.xy);
  let cb = textureLoad(backdropTex, coord, 0); // premultiplied linear backdrop
  let cs = textureLoad(sourceTex, coord, 0);   // premultiplied linear source
  let alphaB = cb.a;
  let alphaS = cs.a * bp.opacity;
  var Cb = vec3f(0.0);
  if (cb.a > 0.0) { Cb = cb.rgb / cb.a; }
  var Cs = vec3f(0.0);
  if (cs.a > 0.0) { Cs = cs.rgb / cs.a; }
  let B = blendColor(i32(bp.mode), Cb, Cs);
  // W3C Compositing-1 source-over with blend function B, premultiplied result.
  let co = alphaS * (1.0 - alphaB) * Cs + alphaS * alphaB * B + alphaB * (1.0 - alphaS) * Cb;
  let ao = alphaS + alphaB * (1.0 - alphaS);
  return vec4f(co, ao);
}
`;

// Analytic vector fill (ADR 0007). Per pixel: winding number (ray crossings) for
// inside/outside under the fill rule, plus the exact distance to the nearest
// edge (line or quadratic) for a resolution-independent ~1px anti-aliased rim.
// Geometry is in device px; the fragment position is divided by the supersample
// scale to match, so the AA band is one *display* pixel wide at any zoom.
const PATH_SHADER = /* wgsl */ `
struct Viewport { size : vec2f, scale : f32, _pad : f32 };
@group(0) @binding(0) var<uniform> vp : Viewport;

struct Edge { a : vec2f, b : vec2f, c : vec2f, kind : vec2f };
@group(1) @binding(0) var<storage, read> edges : array<Edge>;
struct PathParams { color : vec4f, bbox : vec4f, counts : vec4u, misc : vec4f };
@group(1) @binding(1) var<uniform> pp : PathParams;
// Row-band acceleration: bandTable[bandTableOffset + row] = (indexOffset, count)
// into edgeIndex, which lists the edges whose y-range touches that horizontal
// band. A pixel only tests its own band's edges.
@group(1) @binding(2) var<storage, read> bandTable : array<vec2u>;
@group(1) @binding(3) var<storage, read> edgeIndex : array<u32>;

@vertex fn vs(@location(0) corner : vec2f) -> @builtin(position) vec4f {
  let pad = 2.0; // device px, so the AA rim is never clipped by the bbox quad
  let lo = pp.bbox.xy - vec2f(pad, pad);
  let hi = pp.bbox.zw + vec2f(pad, pad);
  let dev = mix(lo, hi, corner);
  let clip = vec2f(dev.x / vp.size.x * 2.0 - 1.0, 1.0 - dev.y / vp.size.y * 2.0);
  return vec4f(clip, 0.0, 1.0);
}

fn dLine(p : vec2f, a : vec2f, b : vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}

// Exact distance to a quadratic Bézier (Inigo Quilez, Cardano's method).
fn dQuad(pos : vec2f, A : vec2f, B : vec2f, C : vec2f) -> f32 {
  let a = B - A;
  let b = A - 2.0 * B + C;
  let c = a * 2.0;
  let d = A - pos;
  let kk = 1.0 / max(dot(b, b), 1e-8);
  let kx = kk * dot(a, b);
  let ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
  let kz = kk * dot(d, a);
  let p = ky - kx * kx;
  let p3 = p * p * p;
  let q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
  var h = q * q + 4.0 * p3;
  if (h >= 0.0) {
    h = sqrt(h);
    let x = (vec2f(h, -h) - q) / 2.0;
    let uv = sign(x) * pow(abs(x), vec2f(1.0 / 3.0));
    let t = clamp(uv.x + uv.y - kx, 0.0, 1.0);
    let qd = d + (c + b * t) * t;
    return sqrt(dot(qd, qd));
  }
  let z = sqrt(-p);
  let v = acos(q / (p * z * 2.0)) / 3.0;
  let m = cos(v);
  let n = sin(v) * 1.732050808;
  let t = clamp(vec3f(m + m, -n - m, n - m) * z - kx, vec3f(0.0), vec3f(1.0));
  let q1 = d + (c + b * t.x) * t.x;
  let q2 = d + (c + b * t.y) * t.y;
  return sqrt(min(dot(q1, q1), dot(q2, q2)));
}

fn windLine(p : vec2f, a : vec2f, c : vec2f) -> i32 {
  let up = a.y <= p.y && c.y > p.y;
  let down = c.y <= p.y && a.y > p.y;
  if (!up && !down) { return 0; }
  let t = (p.y - a.y) / (c.y - a.y);
  if (a.x + t * (c.x - a.x) > p.x) {
    if (up) { return 1; }
    return -1;
  }
  return 0;
}

fn crossQuad(p : vec2f, A : vec2f, B : vec2f, C : vec2f, a2 : f32, b1 : f32, t : f32) -> i32 {
  if (t < 0.0 || t > 1.0) { return 0; }
  let u = 1.0 - t;
  let x = u * u * A.x + 2.0 * u * t * B.x + t * t * C.x;
  if (x <= p.x) { return 0; }
  let dy = 2.0 * a2 * t + b1;
  if (dy > 0.0) { return 1; }
  if (dy < 0.0) { return -1; }
  return 0;
}

fn windQuad(p : vec2f, A : vec2f, B : vec2f, C : vec2f) -> i32 {
  let a2 = A.y - 2.0 * B.y + C.y;
  let b1 = 2.0 * (B.y - A.y);
  let c0 = A.y - p.y;
  var w = 0;
  if (abs(a2) < 1e-6) {
    if (abs(b1) > 1e-9) { w = w + crossQuad(p, A, B, C, a2, b1, -c0 / b1); }
    return w;
  }
  let disc = b1 * b1 - 4.0 * a2 * c0;
  if (disc < 0.0) { return 0; }
  let s = sqrt(disc);
  w = w + crossQuad(p, A, B, C, a2, b1, (-b1 - s) / (2.0 * a2));
  w = w + crossQuad(p, A, B, C, a2, b1, (-b1 + s) / (2.0 * a2));
  return w;
}

@fragment fn fs(@builtin(position) frag : vec4f) -> @location(0) vec4f {
  let p = frag.xy / vp.scale; // target px -> device px (edge space)
  // Pick this pixel's horizontal band and iterate only its edges.
  let bandCount = i32(pp.counts.z);
  var row = i32(floor((p.y - pp.misc.y) / pp.misc.z));
  row = clamp(row, 0, bandCount - 1);
  let entry = bandTable[pp.counts.y + u32(row)];
  let idxOffset = entry.x;
  let cnt = entry.y;
  var winding = 0;
  var dist = 1e9;
  for (var j = 0u; j < cnt; j = j + 1u) {
    let e = edges[edgeIndex[idxOffset + j]];
    // Winding always (cheap); the exact distance SDF only matters near the
    // boundary, so skip it for edges whose bbox is far from this pixel.
    let lo = min(min(e.a, e.b), e.c) - vec2f(2.0);
    let hi = max(max(e.a, e.b), e.c) + vec2f(2.0);
    let near = p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y;
    if (e.kind.x > 0.5) {
      if (near) { dist = min(dist, dQuad(p, e.a, e.b, e.c)); }
      winding = winding + windQuad(p, e.a, e.b, e.c);
    } else {
      if (near) { dist = min(dist, dLine(p, e.a, e.c)); }
      winding = winding + windLine(p, e.a, e.c);
    }
  }
  var inside = winding != 0;
  if (pp.counts.x == 1u) { inside = (winding & 1) != 0; }
  let signed = select(dist, -dist, inside);
  let coverage = clamp(0.5 - signed, 0.0, 1.0); // ~1 device-px analytic rim
  let alpha = pp.color.a * pp.misc.x * coverage;
  return vec4f(pp.color.rgb * alpha, alpha); // premultiplied linear
}
`;

const SCENE_FORMAT: GPUTextureFormat = 'rgba16float';
const IMAGE_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';

export class WebGpuRenderer {
  private background: RendererColor = { r: 0, g: 0, b: 0, a: 1 };
  private width: number;
  private height: number;
  /** Requested supersample factor; the effective one may be clamped by limits. */
  /** Requested supersample factor (adjustable live via `setSupersample`). */
  private supersample: number;
  /** Effective (clamped) supersample factor actually in use. */
  private sampleScale = 1;
  private ditherEnabled = false;

  /** The compositing command stream (set by `setRenderList`). */
  private commands: readonly RenderCommand[] = [];
  /** Per-draw-solid instance data (10 floats: transform + premultiplied rgba). */
  private solidBuffer: GPUBuffer | null = null;
  private solidCount = 0;
  /** Per-draw-image instance data (8 floats: transform + opacity). */
  private imageBuffer: GPUBuffer | null = null;
  private imageDrawCount = 0;
  /** Uniform slots (256B each) for per-op blend params. */
  private blendParamsBuffer: GPUBuffer;
  private blendParamsSlots = 0;

  /** Pool of layer-sized targets reused across frames. */
  private readonly targetPool: GPUTexture[] = [];
  private targetFree: GPUTexture[] = [];

  /** Vector-fill state: edge storage, row-band tables, per-draw params. */
  private edgeBuffer: GPUBuffer | null = null;
  private bandTableBuffer: GPUBuffer | null = null;
  private edgeIndexBuffer: GPUBuffer | null = null;
  private pathParamsBuffer: GPUBuffer;
  private pathParamsSlots = 0;
  private pathDraws: PathDraw[] = [];

  private readonly imageCache = new Map<string, CachedImage>();

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext | null,
    readonly format: GPUTextureFormat,
    readonly colorSpace: PredefinedColorSpace,
    private readonly presentPipeline: GPURenderPipeline,
    private readonly presentLayout: GPUBindGroupLayout,
    private readonly paramsBuffer: GPUBuffer,
    private readonly quadPipeline: GPURenderPipeline,
    private readonly quadBindGroup: GPUBindGroup,
    private readonly viewportBuffer: GPUBuffer,
    private readonly unitQuadBuffer: GPUBuffer,
    private readonly noiseTexture: GPUTexture,
    private readonly image: ImageResources,
    private readonly compositor: CompositorResources,
    private readonly pathResources: PathResources,
    width: number,
    height: number,
    supersample: number
  ) {
    this.width = width;
    this.height = height;
    this.supersample = Math.max(1, Math.floor(supersample));
    this.sampleScale = this.computeScale();
    this.blendParamsBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.blendParamsSlots = 1;
    this.pathParamsBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pathParamsSlots = 1;
    this.updateViewport();
    this.writeParams();
  }

  /** The effective supersample factor in use (may be clamped below the request). */
  get scale(): number {
    return this.sampleScale;
  }

  /**
   * Change the supersample factor live (e.g. 1 during interaction for speed, 2
   * when idle for quality). Reallocates the target pool; cheap enough to toggle
   * on interaction start/end, not per frame.
   */
  setSupersample(factor: number): void {
    const f = Math.max(1, Math.floor(factor));
    if (f === this.supersample) {
      return;
    }
    this.supersample = f;
    this.sampleScale = this.computeScale();
    this.destroyTargetPool();
    this.updateViewport();
    this.writeParams();
  }

  static async create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    options: WebGpuRendererOptions = {}
  ): Promise<WebGpuRenderer> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      throw new Error('WebGPU is not available in this environment');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('No WebGPU adapter available');
    }
    const device = await adapter.requestDevice();
    const format = navigator.gpu.getPreferredCanvasFormat();
    const colorSpace = options.colorSpace ?? 'display-p3';

    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (context) {
      context.configure({
        device,
        format,
        alphaMode: 'premultiplied',
        colorSpace,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    // --- present pipeline (scene -> display) ---
    const presentModule = device.createShaderModule({ code: PRESENT_SHADER });
    const presentLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const presentPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [presentLayout] }),
      vertex: { module: presentModule, entryPoint: 'vs' },
      fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const paramsBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // --- quad pipeline (render list -> linear scene target) ---
    const quadModule = device.createShaderModule({ code: QUAD_SHADER });
    const quadLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    const quadPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [quadLayout] }),
      vertex: {
        module: quadModule,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          {
            arrayStride: 40,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x2' },
              { shaderLocation: 2, offset: 8, format: 'float32x2' },
              { shaderLocation: 3, offset: 16, format: 'float32x2' },
              { shaderLocation: 4, offset: 24, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module: quadModule,
        entryPoint: 'fs',
        targets: [
          {
            format: SCENE_FORMAT,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    });
    const viewportBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const quadBindGroup = device.createBindGroup({
      layout: quadLayout,
      entries: [{ binding: 0, resource: { buffer: viewportBuffer } }],
    });
    // Unit square as a triangle-strip: (0,0),(1,0),(0,1),(1,1).
    const unitQuadBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(unitQuadBuffer, 0, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));

    // Blue-noise dither tile (uploaded once; wrapped in the shader).
    const noiseTexture = device.createTexture({
      size: [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: noiseTexture },
      blueNoiseTile(),
      { bytesPerRow: BLUE_NOISE_SIZE, rowsPerImage: BLUE_NOISE_SIZE },
      [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE]
    );

    // --- image pipeline (textured quads -> linear scene target) ---
    const imageModule = device.createShaderModule({ code: IMAGE_SHADER });
    const imageTexLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const imagePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [quadLayout, imageTexLayout] }),
      vertex: {
        module: imageModule,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          {
            arrayStride: 32,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x2' },
              { shaderLocation: 2, offset: 8, format: 'float32x2' },
              { shaderLocation: 3, offset: 16, format: 'float32x2' },
              { shaderLocation: 4, offset: 24, format: 'float32' },
            ],
          },
        ],
      },
      fragment: {
        module: imageModule,
        entryPoint: 'fs',
        targets: [
          {
            format: SCENE_FORMAT,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    });
    // Trilinear + anisotropic for clean minification; linear magnify (the shader
    // upgrades magnification to bicubic itself).
    const imageSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 16,
    });

    // --- mip generation (linear box-downsample per level) ---
    const mipModule = device.createShaderModule({ code: MIP_SHADER });
    const mipLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const mipPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [mipLayout] }),
      vertex: { module: mipModule, entryPoint: 'vs' },
      fragment: { module: mipModule, entryPoint: 'fs', targets: [{ format: IMAGE_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    const mipSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const imageResources: ImageResources = {
      pipeline: imagePipeline,
      texLayout: imageTexLayout,
      sampler: imageSampler,
      mipPipeline,
      mipLayout,
      mipSampler,
    };

    // --- compositor pipeline (backdrop-read blend -> layer target) ---
    const blendModule = device.createShaderModule({ code: BLEND_SHADER });
    const blendLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const blendPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [blendLayout] }),
      vertex: { module: blendModule, entryPoint: 'vs' },
      fragment: { module: blendModule, entryPoint: 'fs', targets: [{ format: SCENE_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    const compositorResources: CompositorResources = {
      pipeline: blendPipeline,
      layout: blendLayout,
    };

    // --- vector-fill pipeline (analytic coverage -> layer target) ---
    const pathModule = device.createShaderModule({ code: PATH_SHADER });
    // The path shader reads the viewport in both stages (fragment needs the
    // supersample scale), so it can't reuse the vertex-only quad layout.
    const pathViewportLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const pathViewportBindGroup = device.createBindGroup({
      layout: pathViewportLayout,
      entries: [{ binding: 0, resource: { buffer: viewportBuffer } }],
    });
    const pathBindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    const pathPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [pathViewportLayout, pathBindLayout] }),
      vertex: {
        module: pathModule,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
        ],
      },
      fragment: {
        module: pathModule,
        entryPoint: 'fs',
        targets: [
          {
            format: SCENE_FORMAT,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    });
    const pathResources: PathResources = {
      pipeline: pathPipeline,
      layout: pathBindLayout,
      viewportBindGroup: pathViewportBindGroup,
    };

    const width = Math.max(1, canvas.width || 1);
    const height = Math.max(1, canvas.height || 1);

    const renderer = new WebGpuRenderer(
      device,
      context,
      format,
      colorSpace,
      presentPipeline,
      presentLayout,
      paramsBuffer,
      quadPipeline,
      quadBindGroup,
      viewportBuffer,
      unitQuadBuffer,
      noiseTexture,
      imageResources,
      compositorResources,
      pathResources,
      width,
      height,
      options.supersample ?? 2
    );
    renderer.setDither(options.dither ?? true);
    return renderer;
  }

  /**
   * Decode+upload an image under `assetId`, building a full mip chain in linear
   * light. Idempotent per id: a re-register replaces the previous texture. The
   * matching `ImageNode`/render-list `assetId` then resolves to this texture.
   */
  registerImage(assetId: string, source: ImageSource): void {
    const width = source.width;
    const height = source.height;
    if (width < 1 || height < 1) {
      throw new Error(`image "${assetId}" has zero size`);
    }
    const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
    const texture = this.device.createTexture({
      size: [width, height],
      format: IMAGE_FORMAT,
      mipLevelCount,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source },
      { texture, mipLevel: 0 },
      [width, height]
    );
    this.generateMips(texture, mipLevelCount);

    const bindGroup = this.device.createBindGroup({
      layout: this.image.texLayout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.image.sampler },
      ],
    });
    this.imageCache.get(assetId)?.texture.destroy();
    this.imageCache.set(assetId, { texture, bindGroup });
  }

  /** Whether an image asset has been registered. */
  hasImage(assetId: string): boolean {
    return this.imageCache.has(assetId);
  }

  /** Drop a registered image and free its texture. */
  disposeImage(assetId: string): void {
    this.imageCache.get(assetId)?.texture.destroy();
    this.imageCache.delete(assetId);
  }

  /** Fill levels 1..n by repeatedly box-downsampling the previous level. */
  private generateMips(texture: GPUTexture, levels: number): void {
    const encoder = this.device.createCommandEncoder();
    for (let level = 1; level < levels; level++) {
      const srcView = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
      const dstView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const bindGroup = this.device.createBindGroup({
        layout: this.image.mipLayout,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: this.image.mipSampler },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: dstView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
      pass.setPipeline(this.image.mipPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  /** Set the linear-light background colour of the scene. */
  setClearColor(color: RendererColor): void {
    this.background = color;
  }

  setDither(enabled: boolean): void {
    this.ditherEnabled = enabled;
    this.writeParams();
  }

  /**
   * Set the compositing command stream. Solids and images are packed into
   * instance buffers in command order (opacity baked into the source so the
   * blend pass never re-applies it); blend-param slots are sized to the number
   * of non-Normal draws plus group pops.
   */
  setRenderList(commands: readonly RenderCommand[]): void {
    this.commands = commands;

    const solids: number[] = [];
    const images: number[] = [];
    const edges: number[] = [];
    const bandTable: number[] = []; // (indexOffset, count) pairs
    const edgeIndex: number[] = []; // global edge indices, grouped by band
    this.pathDraws = [];
    const bandHeight = 8; // device px per horizontal band
    const pad = 2; // AA margin, matching the vertex bbox pad
    let blendOps = 0;
    for (const cmd of commands) {
      if (cmd.op === 'draw-solid') {
        const m = cmd.transform;
        const a = cmd.color.a * cmd.opacity; // bake opacity into premultiplied alpha
        solids.push(m.a, m.b, m.c, m.d, m.e, m.f, cmd.color.r, cmd.color.g, cmd.color.b, a);
        if (cmd.blend !== 'normal') blendOps++;
      } else if (cmd.op === 'draw-image') {
        const m = cmd.transform;
        images.push(m.a, m.b, m.c, m.d, m.e, m.f, cmd.opacity, 0);
        if (cmd.blend !== 'normal') blendOps++;
      } else if (cmd.op === 'draw-path') {
        const edgeBase = edges.length / 8;
        for (const e of cmd.edges) {
          edges.push(e.a.x, e.a.y, e.b.x, e.b.y, e.c.x, e.c.y, e.quad ? 1 : 0, 0);
        }
        // Bin edges into horizontal bands over the (padded) screen bbox.
        const minY = cmd.bounds.minY - pad;
        const maxY = cmd.bounds.maxY + pad;
        const bandCount = Math.max(1, Math.ceil((maxY - minY) / bandHeight));
        const buckets: number[][] = Array.from({ length: bandCount }, () => []);
        cmd.edges.forEach((e, i) => {
          const ey0 = Math.min(e.a.y, e.b.y, e.c.y) - pad;
          const ey1 = Math.max(e.a.y, e.b.y, e.c.y) + pad;
          const b0 = Math.min(bandCount - 1, Math.max(0, Math.floor((ey0 - minY) / bandHeight)));
          const b1 = Math.min(bandCount - 1, Math.max(0, Math.floor((ey1 - minY) / bandHeight)));
          for (let b = b0; b <= b1; b++) {
            buckets[b].push(edgeBase + i);
          }
        });
        const bandTableOffset = bandTable.length / 2;
        for (let b = 0; b < bandCount; b++) {
          bandTable.push(edgeIndex.length, buckets[b].length);
          for (const gi of buckets[b]) {
            edgeIndex.push(gi);
          }
        }
        this.pathDraws.push({
          slot: this.pathDraws.length,
          bandTableOffset,
          bandCount,
          bandMinY: minY,
          bandH: bandHeight,
        });
        if (cmd.blend !== 'normal') blendOps++;
      } else if (cmd.op === 'push-group') {
        blendOps++; // the matching pop composites the group (one blend pass)
      }
    }

    this.solidCount = solids.length / 10;
    this.imageDrawCount = images.length / 8;
    if (this.solidCount > 0) {
      const data = new Float32Array(solids);
      this.solidBuffer = this.ensureVertexBuffer(this.solidBuffer, data.byteLength, 'solid');
      this.device.queue.writeBuffer(this.solidBuffer, 0, data);
    }
    if (this.imageDrawCount > 0) {
      const data = new Float32Array(images);
      this.imageBuffer = this.ensureVertexBuffer(this.imageBuffer, data.byteLength, 'image');
      this.device.queue.writeBuffer(this.imageBuffer, 0, data);
    }
    if (edges.length > 0) {
      const edgeData = new Float32Array(edges);
      this.edgeBuffer = this.ensureStorageBuffer(this.edgeBuffer, edgeData.byteLength, 'path-edges');
      this.device.queue.writeBuffer(this.edgeBuffer, 0, edgeData);
      const tableData = new Uint32Array(bandTable);
      this.bandTableBuffer = this.ensureStorageBuffer(this.bandTableBuffer, tableData.byteLength, 'path-bands');
      this.device.queue.writeBuffer(this.bandTableBuffer, 0, tableData);
      const indexData = new Uint32Array(edgeIndex);
      this.edgeIndexBuffer = this.ensureStorageBuffer(this.edgeIndexBuffer, indexData.byteLength, 'path-edge-index');
      this.device.queue.writeBuffer(this.edgeIndexBuffer, 0, indexData);
      this.packPathParams(commands);
    }
    this.ensureBlendParams(blendOps);
  }

  /** Pack per-path-draw uniforms (color, bbox, counts, opacity) into 256B slots. */
  private packPathParams(commands: readonly RenderCommand[]): void {
    this.ensurePathParams(this.pathDraws.length);
    const buf = new ArrayBuffer(this.pathDraws.length * 256);
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    let draw = 0;
    for (const cmd of commands) {
      if (cmd.op !== 'draw-path') {
        continue;
      }
      const rec = this.pathDraws[draw];
      const o = draw * 64; // 256 bytes / 4
      f32[o] = cmd.color.r;
      f32[o + 1] = cmd.color.g;
      f32[o + 2] = cmd.color.b;
      f32[o + 3] = cmd.color.a;
      f32[o + 4] = cmd.bounds.minX;
      f32[o + 5] = cmd.bounds.minY;
      f32[o + 6] = cmd.bounds.maxX;
      f32[o + 7] = cmd.bounds.maxY;
      // counts = (fillRule, bandTableOffset, bandCount, _)
      u32[o + 8] = cmd.fillRule === 'evenodd' ? 1 : 0;
      u32[o + 9] = rec.bandTableOffset;
      u32[o + 10] = rec.bandCount;
      // misc = (opacity, bandMinY, bandH, _)
      f32[o + 12] = cmd.opacity;
      f32[o + 13] = rec.bandMinY;
      f32[o + 14] = rec.bandH;
      draw++;
    }
    this.device.queue.writeBuffer(this.pathParamsBuffer, 0, buf);
  }

  private ensureStorageBuffer(existing: GPUBuffer | null, byteLength: number, label: string): GPUBuffer {
    if (existing && existing.size >= byteLength) {
      return existing;
    }
    existing?.destroy();
    return this.device.createBuffer({
      label,
      size: Math.max(16, byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  private ensurePathParams(slots: number): void {
    const need = Math.max(1, slots);
    if (need <= this.pathParamsSlots) {
      return;
    }
    this.pathParamsBuffer.destroy();
    this.pathParamsBuffer = this.device.createBuffer({
      size: need * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pathParamsSlots = need;
  }

  /** Grow a vertex buffer if needed, returning one at least `byteLength` big. */
  private ensureVertexBuffer(existing: GPUBuffer | null, byteLength: number, label: string): GPUBuffer {
    if (existing && existing.size >= byteLength) {
      return existing;
    }
    existing?.destroy();
    return this.device.createBuffer({
      label,
      size: byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  /** Ensure the blend-param uniform buffer has one 256B slot per blend op. */
  private ensureBlendParams(slots: number): void {
    const need = Math.max(1, slots);
    if (need <= this.blendParamsSlots) {
      return;
    }
    this.blendParamsBuffer.destroy();
    this.blendParamsBuffer = this.device.createBuffer({
      size: need * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.blendParamsSlots = need;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.sampleScale = this.computeScale();
    this.destroyTargetPool();
    this.updateViewport();
    this.writeParams();
  }

  render(): void {
    if (!this.context) {
      throw new Error('renderer has no canvas context');
    }
    const encoder = this.device.createCommandEncoder();
    const composite = this.composite(encoder);
    this.presentPass(encoder, composite, this.context.getCurrentTexture().createView());
    this.device.queue.submit([encoder.finish()]);
  }

  async readback(): Promise<ReadbackResult> {
    const bytesPerRow = Math.ceil((this.width * 4) / 256) * 256;
    const output = this.device.createTexture({
      size: [this.width, this.height],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const buffer = this.device.createBuffer({
      size: bytesPerRow * this.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = this.device.createCommandEncoder();
    const composite = this.composite(encoder);
    this.presentPass(encoder, composite, output.createView());
    encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow }, [this.width, this.height]);
    this.device.queue.submit([encoder.finish()]);

    await buffer.mapAsync(GPUMapMode.READ);
    const data = new Uint8ClampedArray(buffer.getMappedRange().slice(0));
    buffer.unmap();
    output.destroy();
    buffer.destroy();

    return { data, width: this.width, height: this.height, format: this.format, bytesPerRow };
  }

  destroy(): void {
    this.paramsBuffer.destroy();
    this.viewportBuffer.destroy();
    this.unitQuadBuffer.destroy();
    this.noiseTexture.destroy();
    this.blendParamsBuffer.destroy();
    this.pathParamsBuffer.destroy();
    this.edgeBuffer?.destroy();
    this.bandTableBuffer?.destroy();
    this.edgeIndexBuffer?.destroy();
    this.solidBuffer?.destroy();
    this.imageBuffer?.destroy();
    this.destroyTargetPool();
    for (const { texture } of this.imageCache.values()) {
      texture.destroy();
    }
    this.imageCache.clear();
  }

  /**
   * Execute the command stream into a stack of layer targets, returning the
   * final root composite (supersampled). Plain "Normal" draws blend onto the
   * top target with fixed-function `over`; non-Normal draws and group pops read
   * the backdrop and blend in a shader, ping-ponging into a fresh target.
   */
  private composite(encoder: GPUCommandEncoder): GPUTexture {
    this.targetFree = [...this.targetPool];

    const root = this.acquireTarget();
    this.clearTarget(encoder, root, {
      r: this.background.r * this.background.a,
      g: this.background.g * this.background.a,
      b: this.background.b * this.background.a,
      a: this.background.a,
    });
    const stack: StackEntry[] = [{ tex: root, opacity: 1, mode: 0 }];

    let solidCursor = 0;
    let imageCursor = 0;
    let pathCursor = 0;
    let blendSlot = 0;

    // Consecutive Normal draws onto the same target share ONE render pass, so
    // the (large, supersampled) target is load+stored once per run rather than
    // once per layer — the dominant bandwidth cost otherwise.
    let openPass: GPURenderPassEncoder | null = null;
    let openTarget: GPUTexture | null = null;
    const flush = (): void => {
      if (openPass) {
        openPass.end();
        openPass = null;
        openTarget = null;
      }
    };
    const passFor = (tex: GPUTexture): GPURenderPassEncoder => {
      if (openPass && openTarget === tex) {
        return openPass;
      }
      flush();
      openPass = encoder.beginRenderPass({
        colorAttachments: [{ view: tex.createView(), loadOp: 'load', storeOp: 'store' }],
      });
      openTarget = tex;
      return openPass;
    };

    for (const cmd of this.commands) {
      const top = stack[stack.length - 1];

      if (cmd.op === 'push-group') {
        flush();
        const target = this.acquireTarget();
        this.clearTarget(encoder, target, { r: 0, g: 0, b: 0, a: 0 });
        stack.push({ tex: target, opacity: cmd.opacity, mode: blendModeIndex(cmd.blend) });
        continue;
      }
      if (cmd.op === 'pop-group') {
        flush();
        const group = stack.pop();
        const parent = stack[stack.length - 1];
        if (!group || !parent) {
          continue;
        }
        const dest = this.acquireTarget();
        this.blendPass(encoder, dest, parent.tex, group.tex, group.mode, group.opacity, blendSlot++);
        this.releaseTarget(parent.tex);
        this.releaseTarget(group.tex);
        stack[stack.length - 1] = { ...parent, tex: dest };
        continue;
      }

      // A leaf draw (solid, image, or vector path).
      const index = cmd.op === 'draw-solid' ? solidCursor : cmd.op === 'draw-image' ? imageCursor : pathCursor;
      if (cmd.blend === 'normal') {
        this.drawLeafInto(passFor(top.tex), cmd, index);
      } else {
        flush();
        const source = this.acquireTarget();
        const spass = encoder.beginRenderPass({
          colorAttachments: [{ view: source.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
        });
        this.drawLeafInto(spass, cmd, index);
        spass.end();
        const dest = this.acquireTarget();
        // Opacity is already baked into the source, so blend at opacity 1.
        this.blendPass(encoder, dest, top.tex, source, blendModeIndex(cmd.blend), 1, blendSlot++);
        this.releaseTarget(top.tex);
        this.releaseTarget(source);
        stack[stack.length - 1] = { ...top, tex: dest };
      }
      if (cmd.op === 'draw-solid') {
        solidCursor++;
      } else if (cmd.op === 'draw-image') {
        imageCursor++;
      } else {
        pathCursor++;
      }
    }

    flush();
    return stack[0].tex;
  }

  /** Record one leaf (solid / image / path) into an open pass (fixed-func over). */
  private drawLeafInto(pass: GPURenderPassEncoder, cmd: RenderCommand, index: number): void {
    if (cmd.op === 'draw-image') {
      const cached = this.imageCache.get(cmd.assetId);
      if (!cached || !this.imageBuffer) {
        return; // asset not registered yet
      }
      pass.setPipeline(this.image.pipeline);
      pass.setBindGroup(0, this.quadBindGroup);
      pass.setBindGroup(1, cached.bindGroup);
      pass.setVertexBuffer(0, this.unitQuadBuffer);
      pass.setVertexBuffer(1, this.imageBuffer);
      pass.draw(4, 1, 0, index);
      return;
    }
    if (cmd.op === 'draw-path') {
      if (!this.edgeBuffer || !this.bandTableBuffer || !this.edgeIndexBuffer) {
        return;
      }
      const bindGroup = this.device.createBindGroup({
        layout: this.pathResources.layout,
        entries: [
          { binding: 0, resource: { buffer: this.edgeBuffer } },
          { binding: 1, resource: { buffer: this.pathParamsBuffer, offset: index * 256, size: 64 } },
          { binding: 2, resource: { buffer: this.bandTableBuffer } },
          { binding: 3, resource: { buffer: this.edgeIndexBuffer } },
        ],
      });
      pass.setPipeline(this.pathResources.pipeline);
      pass.setBindGroup(0, this.pathResources.viewportBindGroup);
      pass.setBindGroup(1, bindGroup);
      pass.setVertexBuffer(0, this.unitQuadBuffer);
      pass.draw(4);
      return;
    }
    if (!this.solidBuffer) {
      return;
    }
    pass.setPipeline(this.quadPipeline);
    pass.setBindGroup(0, this.quadBindGroup);
    pass.setVertexBuffer(0, this.unitQuadBuffer);
    pass.setVertexBuffer(1, this.solidBuffer);
    pass.draw(4, 1, 0, index);
  }

  /** Composite `source` over `backdrop` into `dest` via the blend shader. */
  private blendPass(
    encoder: GPUCommandEncoder,
    dest: GPUTexture,
    backdrop: GPUTexture,
    source: GPUTexture,
    mode: number,
    opacity: number,
    slot: number
  ): void {
    const offset = slot * 256;
    this.device.queue.writeBuffer(
      this.blendParamsBuffer,
      offset,
      new Float32Array([mode, opacity, 0, 0])
    );
    const bindGroup = this.device.createBindGroup({
      layout: this.compositor.layout,
      entries: [
        { binding: 0, resource: backdrop.createView() },
        { binding: 1, resource: source.createView() },
        { binding: 2, resource: { buffer: this.blendParamsBuffer, offset, size: 16 } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: dest.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(this.compositor.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** Present pass: box-downsample the supersampled composite to the display. */
  private presentPass(encoder: GPUCommandEncoder, composite: GPUTexture, targetView: GPUTextureView): void {
    const bindGroup = this.device.createBindGroup({
      layout: this.presentLayout,
      entries: [
        { binding: 0, resource: composite.createView() },
        { binding: 1, resource: { buffer: this.paramsBuffer } },
        { binding: 2, resource: this.noiseTexture.createView() },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(this.presentPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  private clearTarget(encoder: GPUCommandEncoder, target: GPUTexture, color: RendererColor): void {
    encoder
      .beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: color }],
      })
      .end();
  }

  /** Take a free layer target from the pool, or grow the pool. */
  private acquireTarget(): GPUTexture {
    const free = this.targetFree.pop();
    if (free) {
      return free;
    }
    const target = this.device.createTexture({
      size: [this.width * this.sampleScale, this.height * this.sampleScale],
      format: SCENE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.targetPool.push(target);
    return target;
  }

  private releaseTarget(target: GPUTexture): void {
    this.targetFree.push(target);
  }

  private destroyTargetPool(): void {
    for (const target of this.targetPool) {
      target.destroy();
    }
    this.targetPool.length = 0;
    this.targetFree = [];
  }

  private updateViewport(): void {
    // Viewport stays at *display* resolution: clip space is resolution-
    // independent, so the render list rasterizes into the larger (supersampled)
    // scene target at higher density without any change to its coordinates. The
    // third component carries the supersample scale (the path shader divides the
    // fragment position by it to reach device-pixel edge space).
    this.device.queue.writeBuffer(
      this.viewportBuffer,
      0,
      new Float32Array([this.width, this.height, this.sampleScale, 0])
    );
  }

  private writeParams(): void {
    this.device.queue.writeBuffer(
      this.paramsBuffer,
      0,
      new Float32Array([this.ditherEnabled ? 1 : 0, this.sampleScale, 0, 0])
    );
  }

  /** The supersample factor that fits within the device's texture-size limit. */
  private computeScale(): number {
    const max = this.device.limits.maxTextureDimension2D;
    let scale = this.supersample;
    while (scale > 1 && (this.width * scale > max || this.height * scale > max)) {
      scale -= 1;
    }
    return scale;
  }
}
