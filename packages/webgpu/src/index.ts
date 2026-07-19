// @rendera/webgpu — the WebGPU rendering backend (ADR 0002/0005).
//
// First slice: device acquisition + a colour-correct present that encodes a
// linear-light rgba16float scene target to the display (ADR 0003). Geometry,
// compositor, tiling, and blend modes follow.

export * from './lib/color';
export * from './lib/renderer';
