import {
  createTransform,
  SceneDocument,
  vec2,
  type GroupNode,
  type LayerNode,
} from '@rendera/core';

/** A small demo document shared by the inspector and the WebGPU showcase. */
export function createSampleDocument(): SceneDocument {
  const doc = SceneDocument.create({ name: 'Sample' });
  const group = doc.insert<GroupNode>({
    type: 'group',
    name: 'Group',
    transform: createTransform({ translation: vec2(80, 70) }),
  });
  doc.insert<LayerNode>(
    {
      type: 'layer',
      name: 'A',
      size: vec2(120, 80),
      fill: { type: 'solid', color: { r: 0.15, g: 0.4, b: 0.85, a: 1 } },
    },
    { parentId: group.id }
  );
  doc.insert<LayerNode>(
    {
      type: 'layer',
      name: 'B',
      size: vec2(90, 90),
      transform: createTransform({ translation: vec2(80, 60), rotation: 0.3 }),
      fill: { type: 'solid', color: { r: 0.9, g: 0.35, b: 0.2, a: 1 } },
    },
    { parentId: group.id }
  );
  doc.insert<LayerNode>({
    type: 'layer',
    name: 'C',
    size: vec2(110, 60),
    transform: createTransform({ translation: vec2(280, 40) }),
    fill: { type: 'solid', color: { r: 0.2, g: 0.7, b: 0.4, a: 1 } },
  });
  return doc;
}
