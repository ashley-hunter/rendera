/**
 * SVG import — owned, dependency-free, DOM-free.
 *
 * Parses SVG source into scene-document nodes: the full path-data grammar, basic
 * shapes, groups + transforms, viewBox mapping, solid + gradient paints from
 * presentation attributes / inline `style=`, and text. See ADR 0010.
 */

export { importSvg, type SvgImportOptions, type SvgImportResult, type FontResolver } from './import';
export { exportSvg, pathToData, type SvgExportOptions } from './export';
export { parsePathData } from './path-data';
export { parseTransform } from './transform-attr';
export { parseColor } from './color';
export { parseXml, textContent, type XmlElement } from './xml';
export {
  collectGradients,
  resolveGradient,
  paintRefId,
  parseInlineStyle,
  type GradientRegistry,
} from './gradients';
