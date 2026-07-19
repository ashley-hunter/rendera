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
    { type: 'layer', name: 'A', size: vec2(120, 80) },
    { parentId: group.id }
  );
  doc.insert<LayerNode>(
    {
      type: 'layer',
      name: 'B',
      size: vec2(90, 90),
      transform: createTransform({ translation: vec2(80, 60), rotation: 0.3 }),
    },
    { parentId: group.id }
  );
  doc.insert<LayerNode>({
    type: 'layer',
    name: 'C',
    size: vec2(110, 60),
    transform: createTransform({ translation: vec2(280, 40) }),
  });
  return doc;
}
