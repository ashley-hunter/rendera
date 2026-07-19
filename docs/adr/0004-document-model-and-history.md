# ADR 0004 — Document model, history, and collaboration-readiness

- **Status:** Accepted
- **Date:** 2026-07-19
- **Relates to:** ADR 0001 (foundational engine first), ADR 0002 (renderer seam)

## Context

The document model is the most expensive decision to reverse: it pins
serialization/file format, undo, selection, and any future multiplayer. Research
into Figma, tldraw, and Excalidraw shows a consistent pattern — a **flat,
serializable, ID-keyed store**, with behaviour separated from data, and history
expressed as **diffs** over that store. The product owner has chosen to **design
for real-time multiplayer without building it now**.

## Decision

### Document representation — flat, ID-keyed record store

- The document is a **`Map<NodeId, Node>`** of plain, serializable **records**
  (an "ECS-ish, data-as-components" model), not an OOP object graph.
- **Hierarchy is data on the node**: each child stores its `parentId` plus a
  **fractional index (LexoRank)** string for sibling z-order. The tree is derived;
  nested child arrays are never the source of truth. Reordering touches only the
  moved node (O(1), conflict-friendly).
- **Behaviour lives in per-type "util" registries** (`getBounds`, `getGeometry`,
  `hitTest`, `serialize`), looked up by `node.type` — never stored on the record.
- **Node taxonomy:** containers (`Document` → `Page` → `Group`/`Frame`); content
  (`VectorPath`/`Shape`, `RasterLayer` (tiled pixel buffer), `Text`, `Image`);
  and **non-destructive** nodes (`AdjustmentLayer`, `Mask`, `SmartObject`/
  `Instance`, and an `EffectStack` on any node). Effects/adjustments are a
  **parametric op-list evaluated at render time**, never baked into pixels.
- **Serializable from day one** with an explicit **schema version + migrations**.
  The file format is the most permanent contract.

### History — diff/mark-based over the store

- Edits are recorded as **forward + inverse store diffs**, bounded by **marks**
  (undoable stop-points), grouped by **batch/transaction**, and **squashed** for
  live drags (a crop/drag collapses to one entry).
- **Ephemeral state** (hover, selection, camera, collaborator cursors) is
  excluded from history.
- **Raster edits** are inherently non-invertible, so their diff is a
  **tile-snapshot delta** — capture only the tiles a stroke touched. The
  `RasterLayer` is a tiled buffer so undo, dirty-rect re-render, and memory all
  key off tiles.
- Undo is **diff-based and scoped**, not a global linear command stack — this is
  what keeps it compatible with future per-user semantic undo in multiplayer.

### Collaboration-readiness (designed-for, not built)

- The flat, ID-addressed store, scoped diff-based undo, and fractional indexing
  are exactly the primitives a later CRDT / last-writer-wins-per-property sync
  needs. We add none of that machinery now, but make no choice that precludes it.
- The **camera is per-viewer viewport state, not part of the document**, so it
  never pollutes undo or multiplayer sync.

### Model / render boundary

- The CPU model is **authoritative and commits synchronously**. Rendering
  (composite, filters, effects) is an **eventually-consistent projection** driven
  off store diffs / dirty tiles; it may be batched, debounced, moved to a
  worker/OffscreenCanvas, and cancelled when superseded. **Undo never awaits the
  GPU.**

## Consequences

- More upfront discipline than an OOP scene graph: data, behaviour, and rendering
  are deliberately separated. The payoff is headless testability ("after this
  command, node X has bounds Y and pointer P hits node Z" with no canvas),
  clean serialization, robust undo, and an open door to multiplayer.
- Reactivity is provided by a **framework-neutral change feed** (store diffs,
  which we already produce for undo) or a tiny internal signals layer — never
  RxJS/Angular signals internally; the Angular wrapper maps the feed to its own
  signals.
- Hard-to-reverse flags now closed: flat store (chosen), first-class
  non-destructive op-lists (chosen), diff/scoped undo (chosen), schema+migration
  from day one (required).
