import type { Meta, StoryObj } from '@storybook/angular';
import { createTextScene } from './text-scene';
import { createVectorScene } from './vector-scene';
import { WebGpuScene } from './webgpu-scene';

/**
 * The interactive editor, one capability per story. Every story is the same
 * `WebGpuScene` component with different inputs enabled, so you can exercise each
 * feature in isolation. The `Everything` story turns them all on at once.
 */
const meta: Meta<WebGpuScene> = {
  component: WebGpuScene,
  title: 'Editor',
};
export default meta;

type Story = StoryObj<WebGpuScene>;

/**
 * **Select & transform.** Click a shape to select it (Shift-click adds/removes).
 * The selection shows an oriented frame: drag the body to **move**, a corner/edge
 * to **scale** (Shift keeps aspect, Alt scales from centre), or the top grip to
 * **rotate**. The frame stays aligned with a rotated shape, so scaling never
 * skews it. Everything here is one undo step.
 */
export const SelectAndTransform: Story = {
  args: { scene: createVectorScene(), selectable: true },
};

/**
 * **Marquee selection.** Drag from empty space to rubber-band select every shape
 * the box touches (Shift adds to the current selection). Hold **Space** and drag
 * to pan instead. A plain click on empty space clears the selection.
 */
export const MarqueeSelection: Story = {
  args: { scene: createVectorScene(), selectable: true },
};

/**
 * **Keyboard editing.** With a selection: **arrow keys** nudge (Shift = a coarser
 * step), **Delete/Backspace** removes, **Cmd/Ctrl+D** duplicates. Each is a
 * single undo, and **Cmd/Ctrl+Z** / **+Shift+Z** step through the history.
 */
export const KeyboardEditing: Story = {
  args: { scene: createVectorScene(), selectable: true, keyboardEditing: true },
};

/**
 * **Snapping & alignment guides.** Drag a shape near another and its edges/centre
 * snap to the neighbour's, drawing pink alignment guides that bridge the aligned
 * boxes. Hold **Cmd/Ctrl** while dragging to move freely (no snap).
 */
export const SnappingGuides: Story = {
  args: { scene: createVectorScene(), selectable: true, snapping: true },
};

/**
 * **Align & distribute.** Select **two or more** shapes and the toolbar grows an
 * align group (left / centre / right / top / middle / bottom, relative to the
 * selection's bounding box); **three or more** adds distribute (even out the
 * centres horizontally or vertically). Each is one undo step.
 */
export const AlignAndDistribute: Story = {
  args: { scene: createVectorScene(), selectable: true, alignTools: true },
};

/**
 * **Grouping.** Select two or more shapes and press **Cmd/Ctrl+G** to wrap them
 * in a group; **Shift+G** ungroups. Grouping/ungrouping preserves each shape's
 * on-screen position even when the group carries its own transform.
 */
export const Grouping: Story = {
  args: { scene: createVectorScene(), selectable: true, grouping: true, showLayers: true },
};

/**
 * **Boolean operations.** Select two or more path shapes and the toolbar shows
 * boolean buttons — **union / subtract / intersect / exclude**. Each combines the
 * selection into one non-destructive boolean node (the operands stay editable
 * inside it) as a single undo step, and selects the result.
 */
export const BooleanOps: Story = {
  args: { scene: createVectorScene(), selectable: true, booleans: true, showLayers: true },
};

/**
 * **Copy / cut / paste.** **Cmd/Ctrl+C** copies the selection, **+X** cuts,
 * **+V** pastes an offset copy (and selects it). The clipboard captures whole
 * subtrees, so pasting a group re-creates its children with fresh ids.
 */
export const CopyPaste: Story = {
  args: { scene: createVectorScene(), selectable: true, clipboardKeys: true },
};

/**
 * **Layers panel.** The document tree, front-to-back. Click a row to select it,
 * toggle the dot to hide/show a node, expand/collapse a group with the caret, and
 * **drag rows** to reorder or drop one into a group — visibility and reorder are
 * each one undo step and stay in sync with the canvas selection.
 */
export const LayersPanel: Story = {
  args: { scene: createVectorScene(), selectable: true, showLayers: true },
};

/**
 * **Properties inspector.** Edit the selection: opacity, blend mode, and
 * visibility apply to every selected node; fill/stroke colour, stroke width, and
 * X/Y position show for a single shape. Each edit is one undo step.
 */
export const Inspector: Story = {
  args: { scene: createVectorScene(), selectable: true, showInspector: true },
};

/**
 * **Rulers & grid.** Coordinate rulers line the top/left with live world units
 * that reproject as you pan and zoom, and a grid shows through the scene. Moving
 * a shape snaps to the grid (shape-to-shape alignment still wins where it
 * applies).
 */
export const RulersAndGrid: Story = {
  args: { scene: createVectorScene(), selectable: true, showRulers: true, gridSize: 25 },
};

/**
 * **Drawing tools.** Use the toolbar (or shortcuts): **Rectangle (R)**,
 * **Ellipse (O)**, and **Polygon** drag out with a live preview; **Pen (P)**
 * draws Bézier paths — **click** for a corner point, or **click-drag** to pull
 * out smooth curve handles. Click the first point to close into a filled region,
 * or double-click to finish an open stroked path. **V** / **Esc** returns to
 * Select. Each new shape is one undo step, and its points stay editable
 * afterwards (see Path point editing).
 */
export const DrawingTools: Story = {
  args: { scene: createVectorScene(), selectable: true, drawing: true },
};

/**
 * **Live-shape controls.** Draw a **Rectangle** or **Polygon**, then edit it as a
 * parametric "live shape" in the inspector: a rectangle gains a **Radius** field
 * (round its corners) and a polygon a **Sides** field (change its vertex count) —
 * the geometry re-derives from the recipe on each change, as one undo. Existing
 * shapes stay plain paths until you draw new ones.
 */
export const ShapeControls: Story = {
  args: { scene: createVectorScene(), selectable: true, drawing: true, showInspector: true },
};

/**
 * **Inline text editing.** Double-click a text line to edit it in place — an
 * overlay sits exactly over the glyphs (matching position, rotation, scale, and
 * colour). **Enter** commits (Shift+Enter for a newline), **Esc** cancels; a
 * commit re-shapes the outline as a single undo.
 */
export const TextEditing: Story = {
  args: { scene: createTextScene(), selectable: true, textEditing: true, showInspector: true },
};

/**
 * **Path point editing.** Select a single path and its **anchor points** (white
 * squares) and **control points** (blue dots, joined to their anchors by handle
 * lines) appear in place of the transform frame. Drag any point to reshape the
 * curve — each drag is one undo. Dragging the path body still moves the whole
 * shape; click empty space to deselect.
 */
export const PathEditing: Story = {
  args: { scene: createVectorScene(), selectable: true, pathEditing: true },
};

/**
 * **Export.** The **SVG** button downloads the scene as a re-importable vector
 * file; **PNG** captures the current frame as a raster image.
 */
export const Export: Story = {
  args: { scene: createVectorScene(), selectable: true, exportable: true },
};

/**
 * **Everything.** All of the above at once — tools, selection, snapping, align /
 * distribute, grouping, booleans, copy/paste, the layers panel, the properties
 * inspector, rulers + grid, and SVG/PNG export.
 */
export const Everything: Story = {
  args: {
    scene: createVectorScene(),
    selectable: true,
    snapping: true,
    drawing: true,
    alignTools: true,
    booleans: true,
    grouping: true,
    clipboardKeys: true,
    keyboardEditing: true,
    textEditing: true,
    exportable: true,
    showLayers: true,
    showInspector: true,
    showRulers: true,
    gridSize: 25,
  },
};
