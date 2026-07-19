import { SceneDocument } from './document';
import { asNodeId, createSequentialIdFactory } from './id';
import type { LayerNode } from './node';
import {
  addToSelection,
  clearSelection,
  createSelection,
  EMPTY_SELECTION,
  isSelected,
  pruneSelection,
  removeFromSelection,
  resolveSelectionClick,
  selectionSize,
  selectOnly,
  toggleSelection,
} from './selection';

const a = asNodeId('a');
const b = asNodeId('b');
const c = asNodeId('c');

describe('selection value + ops', () => {
  it('starts empty', () => {
    expect(selectionSize(EMPTY_SELECTION)).toBe(0);
    expect(EMPTY_SELECTION.primary).toBeNull();
    expect(selectionSize(createSelection())).toBe(0);
  });

  it('selectOnly replaces and sets primary', () => {
    const s = selectOnly(createSelection([a, b]), c);
    expect([...s.ids]).toEqual([c]);
    expect(s.primary).toBe(c);
    expect(isSelected(s, c)).toBe(true);
    expect(isSelected(s, a)).toBe(false);
  });

  it('add/remove/toggle update ids and primary', () => {
    let s = selectOnly(EMPTY_SELECTION, a);
    s = addToSelection(s, b);
    expect(selectionSize(s)).toBe(2);
    expect(s.primary).toBe(b);

    s = toggleSelection(s, b); // removes b
    expect(isSelected(s, b)).toBe(false);
    expect(s.primary).toBe(a);

    s = toggleSelection(s, c); // adds c
    expect(isSelected(s, c)).toBe(true);

    s = removeFromSelection(s, a);
    expect(isSelected(s, a)).toBe(false);
    expect(clearSelection()).toBe(EMPTY_SELECTION);
  });

  it('does not mutate the input selection', () => {
    const s = createSelection([a]);
    addToSelection(s, b);
    expect(selectionSize(s)).toBe(1);
  });
});

describe('resolveSelectionClick', () => {
  const base = createSelection([a]);

  it('replaces on a plain click, clears on empty click', () => {
    expect([...resolveSelectionClick(base, b, {}).ids]).toEqual([b]);
    expect(resolveSelectionClick(base, null, {})).toBe(EMPTY_SELECTION);
  });

  it('toggles on additive click, ignores additive empty click', () => {
    expect(selectionSize(resolveSelectionClick(base, b, { additive: true }))).toBe(2);
    expect(isSelected(resolveSelectionClick(base, a, { additive: true }), a)).toBe(false);
    expect(resolveSelectionClick(base, null, { additive: true })).toBe(base);
  });
});

describe('pruneSelection', () => {
  it('drops ids no longer in the document and fixes primary', () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    const l1 = doc.insert<LayerNode>({ type: 'layer', name: 'l1' });
    const l2 = doc.insert<LayerNode>({ type: 'layer', name: 'l2' });
    let sel = createSelection([l1.id, l2.id]);
    sel = { ids: sel.ids, primary: l2.id };

    doc.remove(l2.id);
    const pruned = pruneSelection(sel, doc);
    expect([...pruned.ids]).toEqual([l1.id]);
    expect(pruned.primary).toBe(l1.id);
  });
});
