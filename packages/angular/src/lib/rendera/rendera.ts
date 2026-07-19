import { Component } from '@angular/core';
import { core } from '@rendera/core';

/**
 * Angular wrapper around the framework-agnostic `@rendera/core` logic.
 * The rendering logic lives in `@rendera/core`; this component is a thin
 * Angular shell over it.
 */
@Component({
  selector: 'rendera-view',
  imports: [],
  templateUrl: './rendera.html',
  styleUrl: './rendera.css',
})
export class Rendera {
  /** Value produced by the core rendering logic. */
  protected readonly value = core();
}
