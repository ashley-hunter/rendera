import { Component } from '@angular/core';
import { SceneDocument } from '@rendera/core';

/**
 * Angular wrapper around the framework-agnostic `@rendera/core` engine.
 * The engine (document model, and later rendering) lives in `@rendera/core`;
 * this component is a thin Angular shell over it. For now it just proves the
 * wiring by creating a document and reporting its root.
 */
@Component({
  selector: 'rendera-view',
  imports: [],
  templateUrl: './rendera.html',
  styleUrl: './rendera.css',
})
export class Rendera {
  private readonly document = SceneDocument.create({ name: 'Untitled' });

  /** Name of the document's root node, produced by @rendera/core. */
  protected readonly documentName = this.document.root.name;

  /** Number of nodes currently in the document. */
  protected readonly nodeCount = this.document.size;
}
