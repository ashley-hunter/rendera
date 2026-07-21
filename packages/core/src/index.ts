// @rendera/core — the framework-agnostic engine kernel.
//
// This first slice is the document model: node ids, fractional ordering, node
// records, the per-type util registry, and the flat record store. Rendering,
// input, history, and geometry arrive in later phases (see docs/ROADMAP.md).

export * from './lib/id';
export * from './lib/ordering';
export * from './lib/node';
export * from './lib/registry';
export * from './lib/changes';
export * from './lib/document';
export * from './lib/history';
export * from './lib/blend';
export * from './lib/boolean';
export * from './lib/paint';
export * from './lib/path';
export * from './lib/stroke';
export * from './lib/text';
export * from './lib/svg';
export * from './lib/png';
export * from './lib/hit-test';
export * from './lib/transform-handles';
export * from './lib/edit-ops';
export * from './lib/snapping';
export * from './lib/layers';
export * from './lib/align';
export * from './lib/render-list';

// Transform math. `matrix` also defines `approxEquals`; it is re-exported here
// as `matrixApproxEquals` to avoid clashing with the vec2 version.
export * from './lib/vec2';
export * from './lib/transform';
export * from './lib/bounds';
export * from './lib/camera';
export * from './lib/pointer';
export * from './lib/gesture';
export * from './lib/selection';
export {
  IDENTITY,
  mat2d,
  fromTranslation,
  fromScaling,
  fromRotation,
  fromSkew,
  multiply,
  compose,
  determinant,
  invert,
  transformPoint,
  transformVector,
  approxEquals as matrixApproxEquals,
  type Mat2D,
} from './lib/matrix';
