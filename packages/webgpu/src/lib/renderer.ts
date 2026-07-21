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

import {
  blendModeIndex,
  normalizedStops,
  paintKind,
  spreadIndex,
  type Gradient,
  type Paint,
  type RenderCommand,
  type ScreenEffect,
} from '@rendera/core';
import { blueNoiseTile, BLUE_NOISE_SIZE } from './blue-noise';
import { buildTiles } from './tiling';

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

/** GPU resources for the MSDF text pipeline. */
interface MsdfResources {
  pipeline: GPURenderPipeline;
  texLayout: GPUBindGroupLayout;
  sampler: GPUSampler;
}

/** Per-path-draw packing: its params slot and 2D tile-grid location (see
 *  `buildTiles` in tiling.ts). */
interface PathDraw {
  slot: number;
  tileTableOffset: number;
  tilesX: number;
  tilesY: number;
  tileOriginX: number;
  tileOriginY: number;
  tileSize: number;
}

/** A layer target on the compositing stack, with the group's compositing props. */
interface StackEntry {
  tex: GPUTexture;
  opacity: number;
  mode: number;
  /** If set, this coverage target modulates the layer at pop (clip/soft mask). */
  maskTex?: GPUTexture;
  /** Mask channel: 0 = luminance, 1 = alpha. */
  maskChannel?: number;
  /** Effects applied to the layer at pop (after the mask, before compositing). */
  effects?: readonly ScreenEffect[];
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

// Clip/mask application: multiply a layer's premultiplied RGBA by a per-pixel
// coverage read from a mask target. `channel` 0 = luminance (of the mask's
// premultiplied linear RGB — already alpha-weighted, matching SVG's luminance
// mask), 1 = alpha (used for geometric clips, whose mask is the clip path filled
// opaque). Multiplying premultiplied colour by a scalar stays premultiplied.
const MASK_SHADER = /* wgsl */ `
@group(0) @binding(0) var layerTex : texture_2d<f32>;
@group(0) @binding(1) var maskTex : texture_2d<f32>;
struct MaskP { channel : f32, _p0 : f32, _p1 : f32, _p2 : f32 };
@group(0) @binding(2) var<uniform> mp : MaskP;

@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) frag : vec4f) -> @location(0) vec4f {
  let coord = vec2i(frag.xy);
  let layer = textureLoad(layerTex, coord, 0);
  let m = textureLoad(maskTex, coord, 0);
  var coverage = m.a;
  if (mp.channel < 0.5) { coverage = 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b; }
  return layer * coverage;
}
`;

// Separable Gaussian blur (one axis per pass). textureLoad returns 0 outside the
// target, so the premultiplied layer fades to transparent at the edges — exactly
// what a blur of finite content should do. `dir` is the integer step (1,0)/(0,1).
const BLUR_SHADER = /* wgsl */ `
@group(0) @binding(0) var srcTex : texture_2d<f32>;
struct BlurP { sigma : f32, taps : f32, dirX : f32, dirY : f32 };
@group(0) @binding(1) var<uniform> bp : BlurP;

@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) frag : vec4f) -> @location(0) vec4f {
  let coord = vec2i(frag.xy);
  let dir = vec2i(i32(bp.dirX), i32(bp.dirY));
  let n = i32(bp.taps);
  let inv = 1.0 / max(2.0 * bp.sigma * bp.sigma, 1e-4);
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var i = -n; i <= n; i = i + 1) {
    let w = exp(-f32(i * i) * inv);
    acc = acc + w * textureLoad(srcTex, coord + dir * i, 0);
    wsum = wsum + w;
  }
  return acc / wsum;
}
`;

// Silhouette: a tinted copy of the layer's alpha, optionally offset — the seed
// for a drop shadow (offset) or glow (no offset) before it is blurred. Output is
// premultiplied linear (rgb = colour·coverage), so it blurs and composites like
// any layer.
const SILHOUETTE_SHADER = /* wgsl */ `
@group(0) @binding(0) var srcTex : texture_2d<f32>;
struct SiluP { color : vec4f, offset : vec4f };
@group(0) @binding(1) var<uniform> sp : SiluP;

@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) frag : vec4f) -> @location(0) vec4f {
  let coord = vec2i(frag.xy) - vec2i(i32(sp.offset.x), i32(sp.offset.y));
  let a = textureLoad(srcTex, coord, 0).a;
  let cov = a * sp.color.a;
  return vec4f(sp.color.rgb * cov, cov);
}
`;

// Per-pixel colour adjustment (brightness/contrast, hue/saturation, levels), all
// in linear light. Reads premultiplied linear, un-premultiplies to straight
// colour, transforms, re-premultiplies (alpha untouched). `mode` selects the
// adjustment; params live in p0/p1.
const ADJUST_SHADER = /* wgsl */ `
@group(0) @binding(0) var layerTex : texture_2d<f32>;
struct AdjP { p0 : vec4f, p1 : vec4f, mode : f32, _a : f32, _b : f32, _c : f32 };
@group(0) @binding(1) var<uniform> ap : AdjP;

@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

// SVG feColorMatrix luminance-preserving hue rotation.
fn hueRotate(c : vec3f, a : f32) -> vec3f {
  let cA = cos(a);
  let sA = sin(a);
  let r = dot(c, vec3f(0.213 + cA * 0.787 - sA * 0.213, 0.715 - cA * 0.715 - sA * 0.715, 0.072 - cA * 0.072 + sA * 0.928));
  let g = dot(c, vec3f(0.213 - cA * 0.213 + sA * 0.143, 0.715 + cA * 0.285 + sA * 0.140, 0.072 - cA * 0.072 - sA * 0.283));
  let b = dot(c, vec3f(0.213 - cA * 0.213 - sA * 0.787, 0.715 - cA * 0.715 + sA * 0.715, 0.072 + cA * 0.928 + sA * 0.072));
  return vec3f(r, g, b);
}

@fragment fn fs(@builtin(position) frag : vec4f) -> @location(0) vec4f {
  let src = textureLoad(layerTex, vec2i(frag.xy), 0);
  if (src.a <= 0.0) { return src; }
  var c = src.rgb / src.a; // straight linear colour
  let mode = i32(ap.mode);
  if (mode == 0) {
    c = c + vec3f(ap.p0.x);                 // brightness
    c = (c - vec3f(0.5)) * (1.0 + ap.p0.y) + vec3f(0.5); // contrast about mid-grey
  } else if (mode == 1) {
    c = hueRotate(c, ap.p0.x);
    let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    c = mix(vec3f(luma), c, 1.0 + ap.p0.y); // saturation
    let l = ap.p0.z;                          // lightness
    if (l >= 0.0) { c = mix(c, vec3f(1.0), l); } else { c = mix(c, vec3f(0.0), -l); }
  } else {
    let inB = ap.p0.x; let inW = ap.p0.y; let g = ap.p0.z; let outB = ap.p0.w; let outW = ap.p1.x;
    c = clamp((c - vec3f(inB)) / max(inW - inB, 1e-4), vec3f(0.0), vec3f(1.0));
    c = pow(c, vec3f(1.0 / max(g, 1e-4)));
    c = vec3f(outB) + c * (outW - outB);
  }
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  return vec4f(c * src.a, src.a); // re-premultiply
}
`;

/**
 * Cap on blur taps per axis. Past this, the sample stride widens instead of the
 * tap count, so blur cost is constant regardless of the on-screen radius (a
 * zoomed-in blur no longer explodes into hundreds of taps per pixel).
 */
const BLUR_TAP_CAP = 48;

/** Pack a colour adjustment into a shader mode + [p0..p4] (see ADJUST_SHADER). */
function adjustParams(
  e: Extract<ScreenEffect, { type: 'brightness-contrast' | 'hue-saturation' | 'levels' }>
): [number, number[]] {
  if (e.type === 'brightness-contrast') {
    return [0, [e.brightness, e.contrast, 0, 0, 0]];
  }
  if (e.type === 'hue-saturation') {
    return [1, [((e.hue ?? 0) * Math.PI) / 180, e.saturation ?? 0, e.lightness ?? 0, 0, 0]];
  }
  return [2, [e.inBlack ?? 0, e.inWhite ?? 1, e.gamma ?? 1, e.outBlack ?? 0, e.outWhite ?? 1]];
}

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
// color: solid-paint colour (paint kind 0). grad0/grad1: gradient geometry in
// local space — linear (p0.xy, p1.xy); radial (c0.xy, r0, r1) + (c1.xy); conic
// (center.xy, angle). inv0/inv1: the screen->local affine (a,b,c,d)+(e,f) that
// maps a display pixel back to gradient space. grad: (stopBase, stopCount,
// spread, interp). counts.w is the paint kind (0 solid, 1 linear, 2 radial,
// 3 conic).
struct PathParams {
  color : vec4f,
  bbox : vec4f,
  counts : vec4u,
  misc : vec4f,
  grad0 : vec4f,
  grad1 : vec4f,
  inv0 : vec4f,
  inv1 : vec4f,
  grad : vec4u,
  stroke : vec4f, // x = distance-field stroke half-width (device px), 0 = fill; y = cap-plane count (0..2)
  capA : vec4f,   // butt-cap terminus A: xy = point, zw = outward unit tangent
  capB : vec4f,   // butt-cap terminus B
  tile0 : vec4f,  // tile grid: x = tilesX, y = tilesY, z = originX, w = originY
  tile1 : vec4f,  // x = tileSize, y = tileTableOffset
};
@group(1) @binding(1) var<uniform> pp : PathParams;
// 2D tile acceleration: tileTable[tileTableOffset + ty*tilesX + tx] =
// (indexOffset, count, backdrop, _). indexOffset/count index edgeIndex (this
// tile's edges); backdrop is the winding carried in from every edge outside the
// list. A fragment reads the backdrop and walks only its tile's edges — empty
// tiles (interior/exterior) do no edge work at all.
@group(1) @binding(2) var<storage, read> tileTable : array<vec4i>;
@group(1) @binding(3) var<storage, read> edgeIndex : array<u32>;
// Gradient colour stops, in linear-light. stop.color = rgba; stop.info.x = the
// stop's offset in [0,1]. Each path draw owns the contiguous run
// [grad.x, grad.x + grad.y).
struct GradStop { color : vec4f, info : vec4f };
@group(1) @binding(4) var<storage, read> stops : array<GradStop>;

@vertex fn vs(@location(0) corner : vec2f) -> @builtin(position) vec4f {
  let pad = 2.0; // device px, so the AA rim is never clipped by the bbox quad
  let lo = pp.bbox.xy - vec2f(pad, pad);
  let hi = pp.bbox.zw + vec2f(pad, pad);
  let dev = mix(lo, hi, corner);
  let clip = vec2f(dev.x / vp.size.x * 2.0 - 1.0, 1.0 - dev.y / vp.size.y * 2.0);
  return vec4f(clip, 0.0, 1.0);
}

// Butt-cap coverage factor at an open terminus: 1 on the inward side, a ~1px AA
// ramp across the plane through the endpoint (normal = the outward tangent), 0
// beyond. Gated to the cap disc so it only trims THIS terminus' round overshoot,
// never legitimate stroke body elsewhere (a hairpin, a neighbouring subpath).
fn capClip(p : vec2f, cap : vec4f, half : f32) -> f32 {
  let d = p - cap.xy;
  let reach = half + 1.5;
  if (dot(d, d) > reach * reach) { return 1.0; }
  return clamp(0.5 - dot(d, cap.zw), 0.0, 1.0);
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
  // A (near-)straight quad has b ≈ 0 (control on the chord); the Cardano solve
  // below then divides by ~0 and returns garbage. Such quads come from
  // converting straight cubic edges — treat them as the line A→C.
  let chord = C - A;
  if (dot(b, b) < 1e-4 * max(dot(chord, chord), 1e-8)) {
    return dLine(pos, A, C);
  }
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

// x on the quad at the (unique) parameter in [tlo,thi] where y(t) == p.y. The
// sub-range is monotonic in y, so exactly one root lies inside it.
fn quadCrossX(A : vec2f, B : vec2f, C : vec2f, a2 : f32, b1 : f32, c0 : f32, tlo : f32, thi : f32) -> f32 {
  var t = 0.0;
  if (abs(a2) < 1e-6) {
    t = -c0 / b1;
  } else {
    let s = sqrt(max(b1 * b1 - 4.0 * a2 * c0, 0.0));
    let r0 = (-b1 - s) / (2.0 * a2);
    let r1 = (-b1 + s) / (2.0 * a2);
    t = r0;
    if (r0 < tlo - 1e-4 || r0 > thi + 1e-4) { t = r1; }
  }
  t = clamp(t, tlo, thi);
  let u = 1.0 - t;
  return u * u * A.x + 2.0 * u * t * B.x + t * t * C.x;
}

// One monotonic sub-edge: same half-open scanline rule as windLine (lower-y
// endpoint inclusive, upper exclusive), tested on the sub-edge's exact endpoint
// y-values so a vertex shared with the neighbouring segment counts exactly once.
fn windSub(p : vec2f, x : f32, ya : f32, yb : f32) -> i32 {
  let up = ya <= p.y && yb > p.y;
  let down = yb <= p.y && ya > p.y;
  if (!up && !down) { return 0; }
  if (x > p.x) {
    if (up) { return 1; }
    return -1;
  }
  return 0;
}

fn windQuad(p : vec2f, A : vec2f, B : vec2f, C : vec2f) -> i32 {
  let a2 = A.y - 2.0 * B.y + C.y;
  let b1 = 2.0 * (B.y - A.y);
  let c0 = A.y - p.y;
  // Split at the y-extremum into monotonic pieces, then count each like a line.
  if (abs(a2) > 1e-6) {
    let tex = -b1 / (2.0 * a2);
    if (tex > 0.0 && tex < 1.0) {
      let uex = 1.0 - tex;
      let yex = uex * uex * A.y + 2.0 * uex * tex * B.y + tex * tex * C.y;
      var w = 0;
      w = w + windSub(p, quadCrossX(A, B, C, a2, b1, c0, 0.0, tex), A.y, yex);
      w = w + windSub(p, quadCrossX(A, B, C, a2, b1, c0, tex, 1.0), yex, C.y);
      return w;
    }
  }
  return windSub(p, quadCrossX(A, B, C, a2, b1, c0, 0.0, 1.0), A.y, C.y);
}

// --- gradient evaluation (linear-light; OKLab optional) ---
fn linearToOklab(c : vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = pow(max(l, 0.0), 1.0 / 3.0);
  let m_ = pow(max(m, 0.0), 1.0 / 3.0);
  let s_ = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3f(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  );
}
fn oklabToLinear(c : vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}

// Ramp colour at t in [0,1], interpolating between the two bracketing stops in
// the run [base, base+count). interp 1 mixes through OKLab; else linear-light.
fn rampColor(t : f32, base : u32, count : u32, interp : u32) -> vec4f {
  if (count == 0u) { return vec4f(1.0); }
  if (count == 1u) { return stops[base].color; }
  let last = base + count - 1u;
  var hi = base + 1u;
  loop {
    if (hi >= last) { break; }
    if (stops[hi].info.x >= t) { break; }
    hi = hi + 1u;
  }
  let a = stops[hi - 1u];
  let b = stops[hi];
  let span = b.info.x - a.info.x;
  var f = 0.0;
  if (span > 1e-6) { f = clamp((t - a.info.x) / span, 0.0, 1.0); }
  let alpha = mix(a.color.a, b.color.a, f);
  if (interp == 1u) {
    let rgb = oklabToLinear(mix(linearToOklab(a.color.rgb), linearToOklab(b.color.rgb), f));
    return vec4f(rgb, alpha);
  }
  return vec4f(mix(a.color.rgb, b.color.rgb, f), alpha);
}

// Map t through the spread mode: 0 pad (clamp), 1 repeat, 2 reflect.
fn applySpread(t : f32, spread : u32) -> f32 {
  if (spread == 1u) { return fract(t); }
  if (spread == 2u) {
    let u = fract(t * 0.5) * 2.0;
    return select(u, 2.0 - u, u > 1.0);
  }
  return clamp(t, 0.0, 1.0);
}

// Radial gradient parameter for a local point, two-circle model. Returns the
// largest t whose interpolated radius is non-negative; 1 (end stop) if none.
fn radialT(pt : vec2f) -> f32 {
  let c0 = pp.grad0.xy;
  let r0 = pp.grad0.z;
  let r1 = pp.grad0.w;
  let cd = pp.grad1.xy - c0;
  let dr = r1 - r0;
  let pc = pt - c0;
  let A = dot(cd, cd) - dr * dr;
  let B = dot(pc, cd) + r0 * dr;
  let C = dot(pc, pc) - r0 * r0;
  if (abs(A) < 1e-7) {
    if (abs(B) < 1e-12) { return 1.0; }
    let t = C / (2.0 * B);
    if (r0 + t * dr >= 0.0) { return t; }
    return 1.0;
  }
  let disc = B * B - A * C;
  if (disc < 0.0) { return 1.0; }
  let s = sqrt(disc);
  let ta = (B + s) / A;
  let tb = (B - s) / A;
  var best = -1e9;
  var found = false;
  if (r0 + ta * dr >= 0.0) { best = ta; found = true; }
  if (r0 + tb * dr >= 0.0 && tb > best) { best = tb; found = true; }
  if (found) { return best; }
  return 1.0;
}

// Resolve the paint colour (solid or gradient) at a display-pixel position.
fn paintColor(p : vec2f) -> vec4f {
  let kind = pp.counts.w;
  if (kind == 0u) { return pp.color; }
  // Map the pixel back to gradient (local) space via the screen->local affine.
  let local = vec2f(
    pp.inv0.x * p.x + pp.inv0.z * p.y + pp.inv1.x,
    pp.inv0.y * p.x + pp.inv0.w * p.y + pp.inv1.y
  );
  var t = 0.0;
  if (kind == 1u) {
    let d = pp.grad0.zw - pp.grad0.xy;
    t = dot(local - pp.grad0.xy, d) / max(dot(d, d), 1e-8);
  } else if (kind == 2u) {
    t = radialT(local);
  } else {
    let c = pp.grad0.xy;
    t = fract((atan2(local.y - c.y, local.x - c.x) - pp.grad0.z) / 6.28318530718);
  }
  t = applySpread(t, pp.grad.z);
  return rampColor(t, pp.grad.x, pp.grad.y, pp.grad.w);
}

@fragment fn fs(@builtin(position) frag : vec4f) -> @location(0) vec4f {
  let p = frag.xy / vp.scale; // target px -> device px (edge space)
  let strokeHalf = pp.stroke.x; // > 0 → distance-field stroke over the centerline
  let reach = select(2.0, strokeHalf + 2.0, strokeHalf > 0.0);
  var dist = 1e9;
  // Pick this pixel's tile: winding starts at the tile's backdrop (the carried-in
  // winding from every edge outside the tile) and only this tile's own edges are
  // walked. Empty tiles (interior/exterior of a magnified shape) do no edge work.
  let tilesX = i32(pp.tile0.x);
  let tilesY = i32(pp.tile0.y);
  let tsz = pp.tile1.x;
  let tx = clamp(i32(floor((p.x - pp.tile0.z) / tsz)), 0, tilesX - 1);
  let ty = clamp(i32(floor((p.y - pp.tile0.w) / tsz)), 0, tilesY - 1);
  let tile = tileTable[i32(pp.tile1.y) + ty * tilesX + tx];
  let idxOffset = u32(tile.x);
  let cnt = u32(tile.y);
  var winding = tile.z; // backdrop
  for (var j = 0u; j < cnt; j = j + 1u) {
    let e = edges[edgeIndex[idxOffset + j]];
    // The exact distance SDF only matters within reach of the pixel: for a
    // fill that's the ~1px AA rim, for a stroke it's the whole half-width band.
    let lo = min(min(e.a, e.b), e.c) - vec2f(reach);
    let hi = max(max(e.a, e.b), e.c) + vec2f(reach);
    let near = p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y;
    if (e.kind.x > 0.5) {
      if (near) { dist = min(dist, dQuad(p, e.a, e.b, e.c)); }
      if (strokeHalf == 0.0) { winding = winding + windQuad(p, e.a, e.b, e.c); }
    } else {
      if (near) { dist = min(dist, dLine(p, e.a, e.c)); }
      if (strokeHalf == 0.0) { winding = winding + windLine(p, e.a, e.c); }
    }
  }
  var coverage : f32;
  if (strokeHalf > 0.0) {
    // Distance-field stroke: covered where distance to the centerline ≤ half,
    // with a ~1 device-px analytic edge. Round joins/caps for free.
    coverage = clamp(0.5 + (strokeHalf - dist), 0.0, 1.0);
    // Butt caps: clip the round capsule flat against each open terminus' plane.
    let capCount = u32(pp.stroke.y);
    if (capCount > 0u) { coverage = min(coverage, capClip(p, pp.capA, strokeHalf)); }
    if (capCount > 1u) { coverage = min(coverage, capClip(p, pp.capB, strokeHalf)); }
  } else {
    var inside = winding != 0;
    if (pp.counts.x == 1u) { inside = (winding & 1) != 0; }
    let signed = select(dist, -dist, inside);
    coverage = clamp(0.5 - signed, 0.0, 1.0); // ~1 device-px analytic rim
    // Self-overlapping fills (stroke outlines): keep the interior solid so the
    // AA rim appears only at the true boundary, not internal seams.
    if (pp.misc.w > 0.5 && inside) { coverage = 1.0; }
  }
  let paint = paintColor(p);
  let alpha = paint.a * pp.misc.x * coverage;
  return vec4f(paint.rgb * alpha, alpha); // premultiplied linear
}
`;

// MSDF text: instanced glyph quads sampling the multi-channel distance-field
// atlas. median(r,g,b) reconstructs the true signed distance (0.5 = edge);
// screenPxRange (derived from the baked atlas pxRange and the on-screen texel
// density via fwidth) converts it to a ~1px analytic anti-aliased coverage at
// any scale. Output is premultiplied linear for the `over` blend.
const MSDF_SHADER = /* wgsl */ `
struct Viewport { size : vec2f, scale : f32, _pad : f32 };
@group(0) @binding(0) var<uniform> vp : Viewport;
@group(1) @binding(0) var atlasTex : texture_2d<f32>;
@group(1) @binding(1) var atlasSamp : sampler;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
  @location(1) color : vec4f,
  @location(2) pxRange : f32,
};

@vertex fn vs(
  @location(0) corner : vec2f,
  @location(1) m0 : vec2f,
  @location(2) m1 : vec2f,
  @location(3) m2 : vec2f,
  @location(4) uvRect : vec4f,
  @location(5) color : vec4f,
  @location(6) pxRange : f32
) -> VOut {
  let screen = m0 * corner.x + m1 * corner.y + m2;
  let clip = vec2f(screen.x / vp.size.x * 2.0 - 1.0, 1.0 - screen.y / vp.size.y * 2.0);
  var out : VOut;
  out.pos = vec4f(clip, 0.0, 1.0);
  out.uv = mix(uvRect.xy, uvRect.zw, corner);
  out.color = color;
  out.pxRange = pxRange;
  return out;
}

fn median3(v : vec3f) -> f32 { return max(min(v.r, v.g), min(max(v.r, v.g), v.b)); }

@fragment fn fs(@location(0) uv : vec2f, @location(1) color : vec4f, @location(2) pxRange : f32) -> @location(0) vec4f {
  let sd = median3(textureSample(atlasTex, atlasSamp, uv).rgb);
  let texSize = vec2f(textureDimensions(atlasTex, 0));
  let unitRange = vec2f(pxRange) / texSize;               // range in texture units
  let screenTexSize = vec2f(1.0) / fwidth(uv);            // texels per screen px
  let screenPxRange = max(0.5 * dot(unitRange, screenTexSize), 1.0);
  let coverage = clamp(screenPxRange * (sd - 0.5) + 0.5, 0.0, 1.0);
  let a = coverage * color.a;
  return vec4f(color.rgb * a, a); // premultiplied linear
}
`;

const SCENE_FORMAT: GPUTextureFormat = 'rgba16float';
const IMAGE_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';
const MSDF_FORMAT: GPUTextureFormat = 'rgba8unorm';

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
  /** Per-glyph MSDF instance data (16 floats: transform + uv + colour + pxRange). */
  private msdfBuffer: GPUBuffer | null = null;
  /** Per-draw-msdf instance range (first instance + count), in command order. */
  private msdfDraws: { first: number; count: number }[] = [];
  /** The uploaded MSDF glyph atlas, if any. */
  private msdfAtlas: { texture: GPUTexture; bindGroup: GPUBindGroup } | null = null;
  /** Uniform slots (256B each) for per-op blend params. */
  private blendParamsBuffer: GPUBuffer;
  private blendParamsSlots = 0;
  /** Uniform slots (256B each) for per-op clip/mask channel params. */
  private maskParamsBuffer: GPUBuffer;
  private maskParamsSlots = 0;
  /** Uniform slots (256B each) for per-pass Gaussian-blur params. */
  private blurParamsBuffer: GPUBuffer;
  private blurParamsSlots = 0;
  /** Uniform slots (256B each) for per-op silhouette (shadow/glow) params. */
  private siluParamsBuffer: GPUBuffer;
  private siluParamsSlots = 0;
  /** Uniform slots (256B each) for per-op colour-adjustment params. */
  private adjustParamsBuffer: GPUBuffer;
  private adjustParamsSlots = 0;

  /** Pool of layer-sized targets reused across frames. */
  private readonly targetPool: GPUTexture[] = [];
  private targetFree: GPUTexture[] = [];

  /** Vector-fill state: edge storage, row-band tables, per-draw params. */
  private edgeBuffer: GPUBuffer | null = null;
  private tileTableBuffer: GPUBuffer | null = null;
  private edgeIndexBuffer: GPUBuffer | null = null;
  private pathParamsBuffer: GPUBuffer;
  private pathParamsSlots = 0;
  private pathDraws: PathDraw[] = [];
  /** Gradient colour stops (linear-light), shared across all path draws. */
  private gradStopsBuffer: GPUBuffer | null = null;

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
    private readonly maskCompositor: CompositorResources,
    private readonly blur: CompositorResources,
    private readonly silhouette: CompositorResources,
    private readonly adjust: CompositorResources,
    private readonly pathResources: PathResources,
    private readonly msdf: MsdfResources,
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
    this.maskParamsBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.maskParamsSlots = 1;
    this.blurParamsBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.blurParamsSlots = 1;
    this.siluParamsBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.siluParamsSlots = 1;
    this.adjustParamsBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.adjustParamsSlots = 1;
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

    // --- clip/mask pipeline (layer x coverage -> layer target) ---
    const maskModule = device.createShaderModule({ code: MASK_SHADER });
    const maskLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const maskPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [maskLayout] }),
      vertex: { module: maskModule, entryPoint: 'vs' },
      fragment: { module: maskModule, entryPoint: 'fs', targets: [{ format: SCENE_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    const maskResources: CompositorResources = { pipeline: maskPipeline, layout: maskLayout };

    // --- effect pipelines (Gaussian blur + silhouette) ---
    const effectLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const effectPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [effectLayout] });
    const blurModule = device.createShaderModule({ code: BLUR_SHADER });
    const blurPipeline = device.createRenderPipeline({
      layout: effectPipelineLayout,
      vertex: { module: blurModule, entryPoint: 'vs' },
      fragment: { module: blurModule, entryPoint: 'fs', targets: [{ format: SCENE_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    const siluModule = device.createShaderModule({ code: SILHOUETTE_SHADER });
    const siluPipeline = device.createRenderPipeline({
      layout: effectPipelineLayout,
      vertex: { module: siluModule, entryPoint: 'vs' },
      fragment: { module: siluModule, entryPoint: 'fs', targets: [{ format: SCENE_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    const adjustModule = device.createShaderModule({ code: ADJUST_SHADER });
    const adjustPipeline = device.createRenderPipeline({
      layout: effectPipelineLayout,
      vertex: { module: adjustModule, entryPoint: 'vs' },
      fragment: { module: adjustModule, entryPoint: 'fs', targets: [{ format: SCENE_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    const blurResources: CompositorResources = { pipeline: blurPipeline, layout: effectLayout };
    const siluResources: CompositorResources = { pipeline: siluPipeline, layout: effectLayout };
    const adjustResources: CompositorResources = { pipeline: adjustPipeline, layout: effectLayout };

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
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
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

    // --- MSDF text pipeline (glyph quads sampling the distance-field atlas) ---
    const msdfModule = device.createShaderModule({ code: MSDF_SHADER });
    const msdfTexLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const msdfPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [quadLayout, msdfTexLayout] }),
      vertex: {
        module: msdfModule,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          {
            arrayStride: 64,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x2' },
              { shaderLocation: 2, offset: 8, format: 'float32x2' },
              { shaderLocation: 3, offset: 16, format: 'float32x2' },
              { shaderLocation: 4, offset: 24, format: 'float32x4' },
              { shaderLocation: 5, offset: 40, format: 'float32x4' },
              { shaderLocation: 6, offset: 56, format: 'float32' },
            ],
          },
        ],
      },
      fragment: {
        module: msdfModule,
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
    const msdfSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const msdfResources: MsdfResources = {
      pipeline: msdfPipeline,
      texLayout: msdfTexLayout,
      sampler: msdfSampler,
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
      maskResources,
      blurResources,
      siluResources,
      adjustResources,
      pathResources,
      msdfResources,
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

  /**
   * Upload (or replace) the MSDF glyph atlas that text nodes sample. The image
   * is a tightly-packed RGBA8 field (`MsdfAtlas.texture`); call again after a
   * grow (its `version` changed).
   */
  setMsdfAtlas(data: Uint8ClampedArray, width: number, height: number): void {
    this.msdfAtlas?.texture.destroy();
    const texture = this.device.createTexture({
      size: [width, height],
      format: MSDF_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture },
      data,
      { bytesPerRow: width * 4, rowsPerImage: height },
      [width, height]
    );
    const bindGroup = this.device.createBindGroup({
      layout: this.msdf.texLayout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.msdf.sampler },
      ],
    });
    this.msdfAtlas = { texture, bindGroup };
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
    const msdf: number[] = []; // 16 floats/instance: transform + uv + colour + pxRange
    const tileTable: number[] = []; // (indexOffset, count, backdrop, _) per tile
    const edgeIndex: number[] = []; // global edge indices, grouped by tile
    this.pathDraws = [];
    this.msdfDraws = [];
    const tileSize = 16; // device px per tile
    const pad = 2; // AA margin, matching the vertex bbox pad
    let blendOps = 0;
    let maskOps = 0;
    let blurOps = 0;
    let siluOps = 0;
    let adjustOps = 0;
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
        // Bin edges into a 2D tile grid with a per-tile winding backdrop (see
        // tiling.ts): a fragment reads its tile's carried-in winding and walks
        // only its tile's edges; empty interior/exterior tiles cost nothing. A
        // distance-field stroke ignores winding, so it skips the backdrop.
        // `reach` is how far the distance field looks past an edge.
        const reach = cmd.strokeHalf ? cmd.strokeHalf + pad : pad;
        const grid = buildTiles(cmd.edges, cmd.bounds, reach, tileSize, pad, !cmd.strokeHalf);
        const tileTableOffset = tileTable.length / 4;
        for (const t of grid.tiles) {
          tileTable.push(edgeIndex.length, t.count, t.backdrop, 0);
          for (let j = 0; j < t.count; j++) edgeIndex.push(edgeBase + grid.edgeIndex[t.offset + j]);
        }
        this.pathDraws.push({
          slot: this.pathDraws.length,
          tileTableOffset,
          tilesX: grid.tilesX,
          tilesY: grid.tilesY,
          tileOriginX: grid.originX,
          tileOriginY: grid.originY,
          tileSize: grid.tileSize,
        });
        if (cmd.blend !== 'normal') blendOps++;
      } else if (cmd.op === 'draw-msdf') {
        const first = msdf.length / 16;
        for (const q of cmd.quads) {
          const m = q.transform;
          const a = cmd.color.a * cmd.opacity; // bake opacity into alpha
          msdf.push(
            m.a, m.b, m.c, m.d, m.e, m.f,
            q.uv[0], q.uv[1], q.uv[2], q.uv[3],
            cmd.color.r, cmd.color.g, cmd.color.b, a,
            cmd.pxRange, 0
          );
        }
        this.msdfDraws.push({ first, count: cmd.quads.length });
        if (cmd.blend !== 'normal') blendOps++;
      } else if (cmd.op === 'push-group') {
        blendOps++; // the matching pop composites the group (one blend pass)
        if (cmd.mask) maskOps++; // the pop also applies a clip/mask coverage pass
        for (const e of cmd.effects ?? []) {
          if (e.type === 'blur') {
            blurOps += 2; // horizontal + vertical
          } else if (e.type === 'drop-shadow' || e.type === 'outer-glow') {
            siluOps += 1; // silhouette seed
            blurOps += 2; // blur it
            blendOps += 1; // composite the shadow/glow behind the layer
          } else {
            adjustOps += 1; // one colour-transform pass
          }
        }
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
    if (msdf.length > 0) {
      const data = new Float32Array(msdf);
      this.msdfBuffer = this.ensureVertexBuffer(this.msdfBuffer, data.byteLength, 'msdf');
      this.device.queue.writeBuffer(this.msdfBuffer, 0, data);
    }
    if (edges.length > 0) {
      const edgeData = new Float32Array(edges);
      this.edgeBuffer = this.ensureStorageBuffer(this.edgeBuffer, edgeData.byteLength, 'path-edges');
      this.device.queue.writeBuffer(this.edgeBuffer, 0, edgeData);
      const tableData = new Int32Array(tileTable.length > 0 ? tileTable : [0, 0, 0, 0]);
      this.tileTableBuffer = this.ensureStorageBuffer(this.tileTableBuffer, tableData.byteLength, 'path-tiles');
      this.device.queue.writeBuffer(this.tileTableBuffer, 0, tableData);
      const indexData = new Uint32Array(edgeIndex.length > 0 ? edgeIndex : [0]);
      this.edgeIndexBuffer = this.ensureStorageBuffer(this.edgeIndexBuffer, indexData.byteLength, 'path-edge-index');
      this.device.queue.writeBuffer(this.edgeIndexBuffer, 0, indexData);
      this.packPathParams(commands);
    }
    this.ensureBlendParams(blendOps);
    this.ensureMaskParams(maskOps);
    this.ensureEffectParams(blurOps, siluOps);
    this.ensureAdjustParams(adjustOps);
  }

  /**
   * Pack per-path-draw uniforms into 256B slots — coverage bbox, band table,
   * opacity, and the paint: a flat colour, or a gradient's local-space geometry
   * plus the screen->local matrix and its stop run. Gradient stops for every
   * draw are concatenated into one shared storage buffer.
   */
  private packPathParams(commands: readonly RenderCommand[]): void {
    this.ensurePathParams(this.pathDraws.length);
    const buf = new ArrayBuffer(this.pathDraws.length * 256);
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    const stopData: number[] = []; // GradStop = vec4 color + vec4 meta (offset)
    let draw = 0;
    for (const cmd of commands) {
      if (cmd.op !== 'draw-path') {
        continue;
      }
      const rec = this.pathDraws[draw];
      const o = draw * 64; // 256 bytes / 4
      f32[o + 4] = cmd.bounds.minX;
      f32[o + 5] = cmd.bounds.minY;
      f32[o + 6] = cmd.bounds.maxX;
      f32[o + 7] = cmd.bounds.maxY;
      // counts = (fillRule, _, _, paintKind)
      u32[o + 8] = cmd.fillRule === 'evenodd' ? 1 : 0;
      u32[o + 11] = paintKind(cmd.paint);
      // misc = (opacity, _, _, hardInterior)
      f32[o + 12] = cmd.opacity;
      f32[o + 15] = cmd.hardInterior ? 1 : 0;
      f32[o + 36] = cmd.strokeHalf ?? 0; // stroke.x — distance-field half-width
      // stroke.y = butt-cap plane count; capA/capB (floats 40..47) = point + tangent.
      const caps = cmd.caps ?? [];
      f32[o + 37] = caps.length;
      if (caps.length > 0) {
        f32[o + 40] = caps[0].x;
        f32[o + 41] = caps[0].y;
        f32[o + 42] = caps[0].tx;
        f32[o + 43] = caps[0].ty;
      }
      if (caps.length > 1) {
        f32[o + 44] = caps[1].x;
        f32[o + 45] = caps[1].y;
        f32[o + 46] = caps[1].tx;
        f32[o + 47] = caps[1].ty;
      }
      // tile0 = (tilesX, tilesY, originX, originY); tile1 = (tileSize, tileTableOffset)
      f32[o + 48] = rec.tilesX;
      f32[o + 49] = rec.tilesY;
      f32[o + 50] = rec.tileOriginX;
      f32[o + 51] = rec.tileOriginY;
      f32[o + 52] = rec.tileSize;
      f32[o + 53] = rec.tileTableOffset;
      this.packPaint(cmd.paint, cmd.screenToLocal, f32, u32, o, stopData);
      draw++;
    }
    this.device.queue.writeBuffer(this.pathParamsBuffer, 0, buf);

    const stops = new Float32Array(stopData.length > 0 ? stopData : [0, 0, 0, 0, 0, 0, 0, 0]);
    this.gradStopsBuffer = this.ensureStorageBuffer(this.gradStopsBuffer, stops.byteLength, 'grad-stops');
    this.device.queue.writeBuffer(this.gradStopsBuffer, 0, stops);
  }

  /**
   * Write a paint into a path-param slot: the solid colour, or a gradient's
   * geometry (grad0/grad1, local space), the screen->local affine (inv0/inv1),
   * and its stop-run descriptor (grad). Appends the gradient's stops to
   * `stopData`.
   */
  private packPaint(
    paint: Paint,
    screenToLocal: { a: number; b: number; c: number; d: number; e: number; f: number },
    f32: Float32Array,
    u32: Uint32Array,
    o: number,
    stopData: number[]
  ): void {
    if (paint.type === 'solid') {
      f32[o] = paint.color.r;
      f32[o + 1] = paint.color.g;
      f32[o + 2] = paint.color.b;
      f32[o + 3] = paint.color.a;
      return;
    }
    // grad0 / grad1: geometry in local space (see the shader's PathParams docs).
    if (paint.type === 'linear-gradient') {
      f32[o + 16] = paint.start.x;
      f32[o + 17] = paint.start.y;
      f32[o + 18] = paint.end.x;
      f32[o + 19] = paint.end.y;
    } else if (paint.type === 'radial-gradient') {
      f32[o + 16] = paint.start.center.x;
      f32[o + 17] = paint.start.center.y;
      f32[o + 18] = paint.start.radius;
      f32[o + 19] = paint.end.radius;
      f32[o + 20] = paint.end.center.x;
      f32[o + 21] = paint.end.center.y;
    } else {
      f32[o + 16] = paint.center.x;
      f32[o + 17] = paint.center.y;
      f32[o + 18] = paint.angle ?? 0;
    }
    // inv0 = (a,b,c,d), inv1 = (e,f): the screen->local affine.
    const m = screenToLocal;
    f32[o + 24] = m.a;
    f32[o + 25] = m.b;
    f32[o + 26] = m.c;
    f32[o + 27] = m.d;
    f32[o + 28] = m.e;
    f32[o + 29] = m.f;
    // grad = (stopBase, stopCount, spread, interp)
    const g = paint as Gradient;
    const stops = normalizedStops(g.stops);
    const base = stopData.length / 8;
    u32[o + 32] = base;
    u32[o + 33] = stops.length;
    u32[o + 34] = spreadIndex(g.spread);
    u32[o + 35] = g.interpolation === 'oklab' ? 1 : 0;
    for (const s of stops) {
      stopData.push(s.color.r, s.color.g, s.color.b, s.color.a, s.offset, 0, 0, 0);
    }
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

  /** Ensure the mask-param uniform buffer has one 256B slot per clip/mask apply. */
  private ensureMaskParams(slots: number): void {
    const need = Math.max(1, slots);
    if (need <= this.maskParamsSlots) {
      return;
    }
    this.maskParamsBuffer.destroy();
    this.maskParamsBuffer = this.device.createBuffer({
      size: need * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.maskParamsSlots = need;
  }

  /** Ensure the blur/silhouette uniform buffers have one 256B slot per pass. */
  private ensureEffectParams(blurSlots: number, siluSlots: number): void {
    const nb = Math.max(1, blurSlots);
    if (nb > this.blurParamsSlots) {
      this.blurParamsBuffer.destroy();
      this.blurParamsBuffer = this.device.createBuffer({
        size: nb * 256,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.blurParamsSlots = nb;
    }
    const ns = Math.max(1, siluSlots);
    if (ns > this.siluParamsSlots) {
      this.siluParamsBuffer.destroy();
      this.siluParamsBuffer = this.device.createBuffer({
        size: ns * 256,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.siluParamsSlots = ns;
    }
  }

  /** Ensure the adjustment-param uniform buffer has one 256B slot per op. */
  private ensureAdjustParams(slots: number): void {
    const need = Math.max(1, slots);
    if (need <= this.adjustParamsSlots) {
      return;
    }
    this.adjustParamsBuffer.destroy();
    this.adjustParamsBuffer = this.device.createBuffer({
      size: need * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.adjustParamsSlots = need;
  }

  /** One colour-adjustment pass (`mode` + up to eight params in p0/p1). */
  private adjustPass(
    encoder: GPUCommandEncoder,
    dest: GPUTexture,
    src: GPUTexture,
    mode: number,
    params: readonly number[],
    slot: number
  ): void {
    const offset = slot * 256;
    // p0[4], p1[4], mode, pad×3.
    this.device.queue.writeBuffer(
      this.adjustParamsBuffer,
      offset,
      new Float32Array([params[0], params[1], params[2], params[3], params[4], 0, 0, 0, mode, 0, 0, 0])
    );
    const bindGroup = this.device.createBindGroup({
      layout: this.adjust.layout,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: { buffer: this.adjustParamsBuffer, offset, size: 48 } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: dest.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(this.adjust.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** One separable Gaussian blur pass (horizontal or vertical). */
  private blurPass(
    encoder: GPUCommandEncoder,
    dest: GPUTexture,
    src: GPUTexture,
    sigma: number,
    taps: number,
    dirX: number,
    dirY: number,
    slot: number
  ): void {
    const offset = slot * 256;
    this.device.queue.writeBuffer(this.blurParamsBuffer, offset, new Float32Array([sigma, taps, dirX, dirY]));
    const bindGroup = this.device.createBindGroup({
      layout: this.blur.layout,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: { buffer: this.blurParamsBuffer, offset, size: 16 } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: dest.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(this.blur.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** Render a tinted, optionally-offset silhouette of `src`'s alpha. */
  private silhouettePass(
    encoder: GPUCommandEncoder,
    dest: GPUTexture,
    src: GPUTexture,
    color: { r: number; g: number; b: number; a: number },
    offX: number,
    offY: number,
    slot: number
  ): void {
    const offset = slot * 256;
    this.device.queue.writeBuffer(
      this.siluParamsBuffer,
      offset,
      new Float32Array([color.r, color.g, color.b, color.a, offX, offY, 0, 0])
    );
    const bindGroup = this.device.createBindGroup({
      layout: this.silhouette.layout,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: { buffer: this.siluParamsBuffer, offset, size: 32 } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: dest.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(this.silhouette.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
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
    this.maskParamsBuffer.destroy();
    this.blurParamsBuffer.destroy();
    this.siluParamsBuffer.destroy();
    this.adjustParamsBuffer.destroy();
    this.pathParamsBuffer.destroy();
    this.edgeBuffer?.destroy();
    this.tileTableBuffer?.destroy();
    this.edgeIndexBuffer?.destroy();
    this.gradStopsBuffer?.destroy();
    this.solidBuffer?.destroy();
    this.imageBuffer?.destroy();
    this.msdfBuffer?.destroy();
    this.msdfAtlas?.texture.destroy();
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
    let msdfCursor = 0;
    let blendSlot = 0;
    let maskSlot = 0;
    let blurSlot = 0;
    let siluSlot = 0;
    let adjustSlot = 0;
    // Coverage targets captured by `pop-mask`, consumed by the next masked
    // `push-group` (LIFO — a push-group always follows its pop-mask).
    const pendingMasks: GPUTexture[] = [];

    // Blur `src` (screen-space radius) along both axes; consumes `src`, returns
    // a fresh target (or `src` unchanged when the radius rounds to nothing).
    //
    // The tap count is capped: past the cap the sample STEP widens (stride > 1)
    // instead of adding taps, so cost stays constant as the on-screen radius
    // grows with zoom. The physical sigma/extent are preserved (each tap is
    // `stride` device px, sigma is in sample units), and a wide Gaussian is
    // smooth enough that sparse sampling is indistinguishable. Small radii keep
    // stride 1 — pixel-exact, identical to a dense kernel.
    const blur2 = (src: GPUTexture, screenRadius: number): GPUTexture => {
      const rDev = screenRadius * this.sampleScale;
      if (rDev < 0.5) return src;
      const stride = Math.max(1, Math.ceil(rDev / BLUR_TAP_CAP));
      const taps = Math.max(1, Math.min(BLUR_TAP_CAP, Math.ceil(rDev / stride)));
      const sigma = Math.max(rDev / stride / 3, 0.5); // in sample (stride-step) units
      const h = this.acquireTarget();
      this.blurPass(encoder, h, src, sigma, taps, stride, 0, blurSlot++);
      const v = this.acquireTarget();
      this.blurPass(encoder, v, h, sigma, taps, 0, stride, blurSlot++);
      this.releaseTarget(h);
      this.releaseTarget(src);
      return v;
    };

    // Apply a node's effect chain to its layer; consumes `input`, returns final.
    const applyEffects = (input: GPUTexture, effects: readonly ScreenEffect[]): GPUTexture => {
      let layer = input;
      for (const e of effects) {
        if (e.type === 'blur') {
          layer = blur2(layer, e.radius);
          continue;
        }
        if (e.type === 'brightness-contrast' || e.type === 'hue-saturation' || e.type === 'levels') {
          const adjusted = this.acquireTarget();
          const [mode, params] = adjustParams(e);
          this.adjustPass(encoder, adjusted, layer, mode, params, adjustSlot++);
          this.releaseTarget(layer);
          layer = adjusted;
          continue;
        }
        // Drop shadow / outer glow: a blurred, tinted silhouette behind the layer.
        const offX = e.type === 'drop-shadow' ? e.dx * this.sampleScale : 0;
        const offY = e.type === 'drop-shadow' ? e.dy * this.sampleScale : 0;
        const sil = this.acquireTarget();
        this.silhouettePass(encoder, sil, layer, e.color, offX, offY, siluSlot++);
        const halo = blur2(sil, e.radius);
        const out = this.acquireTarget();
        this.blendPass(encoder, out, halo, layer, 0, 1, blendSlot++); // layer over halo
        this.releaseTarget(halo);
        this.releaseTarget(layer);
        layer = out;
      }
      return layer;
    };

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

      if (cmd.op === 'push-mask') {
        flush();
        const target = this.acquireTarget();
        this.clearTarget(encoder, target, { r: 0, g: 0, b: 0, a: 0 });
        stack.push({ tex: target, opacity: 1, mode: 0 });
        continue;
      }
      if (cmd.op === 'pop-mask') {
        flush();
        const maskEntry = stack.pop();
        if (maskEntry) {
          pendingMasks.push(maskEntry.tex); // consumed by the next masked push-group
        }
        continue;
      }
      if (cmd.op === 'push-group') {
        flush();
        const target = this.acquireTarget();
        this.clearTarget(encoder, target, { r: 0, g: 0, b: 0, a: 0 });
        const maskTex = cmd.mask ? pendingMasks.pop() : undefined;
        stack.push({
          tex: target,
          opacity: cmd.opacity,
          mode: blendModeIndex(cmd.blend),
          maskTex,
          maskChannel: cmd.mask ? (cmd.mask.type === 'alpha' ? 1 : 0) : undefined,
          effects: cmd.effects,
        });
        continue;
      }
      if (cmd.op === 'pop-group') {
        flush();
        const group = stack.pop();
        const parent = stack[stack.length - 1];
        if (!group || !parent) {
          continue;
        }
        // Apply the clip/mask coverage, then effects, before it composites.
        let layer = group.tex;
        if (group.maskTex) {
          const masked = this.acquireTarget();
          this.maskApplyPass(encoder, masked, layer, group.maskTex, group.maskChannel ?? 0, maskSlot++);
          this.releaseTarget(layer);
          this.releaseTarget(group.maskTex);
          layer = masked;
        }
        if (group.effects && group.effects.length > 0) {
          layer = applyEffects(layer, group.effects);
        }
        const dest = this.acquireTarget();
        this.blendPass(encoder, dest, parent.tex, layer, group.mode, group.opacity, blendSlot++);
        this.releaseTarget(parent.tex);
        this.releaseTarget(layer);
        stack[stack.length - 1] = { ...parent, tex: dest };
        continue;
      }

      // A leaf draw (solid, image, vector path, or MSDF text).
      const index =
        cmd.op === 'draw-solid'
          ? solidCursor
          : cmd.op === 'draw-image'
            ? imageCursor
            : cmd.op === 'draw-msdf'
              ? msdfCursor
              : pathCursor;
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
      } else if (cmd.op === 'draw-msdf') {
        msdfCursor++;
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
    if (cmd.op === 'draw-msdf') {
      const range = this.msdfDraws[index];
      if (!this.msdfBuffer || !this.msdfAtlas || !range || range.count === 0) {
        return; // atlas not uploaded, or nothing to draw
      }
      pass.setPipeline(this.msdf.pipeline);
      pass.setBindGroup(0, this.quadBindGroup);
      pass.setBindGroup(1, this.msdfAtlas.bindGroup);
      pass.setVertexBuffer(0, this.unitQuadBuffer);
      pass.setVertexBuffer(1, this.msdfBuffer);
      pass.draw(4, range.count, 0, range.first);
      return;
    }
    if (cmd.op === 'draw-path') {
      if (!this.edgeBuffer || !this.tileTableBuffer || !this.edgeIndexBuffer || !this.gradStopsBuffer) {
        return;
      }
      const bindGroup = this.device.createBindGroup({
        layout: this.pathResources.layout,
        entries: [
          { binding: 0, resource: { buffer: this.edgeBuffer } },
          { binding: 1, resource: { buffer: this.pathParamsBuffer, offset: index * 256, size: 224 } },
          { binding: 2, resource: { buffer: this.tileTableBuffer } },
          { binding: 3, resource: { buffer: this.edgeIndexBuffer } },
          { binding: 4, resource: { buffer: this.gradStopsBuffer } },
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

  /** Multiply a layer's premultiplied RGBA by a mask target's coverage. */
  private maskApplyPass(
    encoder: GPUCommandEncoder,
    dest: GPUTexture,
    layer: GPUTexture,
    mask: GPUTexture,
    channel: number,
    slot: number
  ): void {
    const offset = slot * 256;
    this.device.queue.writeBuffer(this.maskParamsBuffer, offset, new Float32Array([channel, 0, 0, 0]));
    const bindGroup = this.device.createBindGroup({
      layout: this.maskCompositor.layout,
      entries: [
        { binding: 0, resource: layer.createView() },
        { binding: 1, resource: mask.createView() },
        { binding: 2, resource: { buffer: this.maskParamsBuffer, offset, size: 16 } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: dest.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(this.maskCompositor.pipeline);
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
