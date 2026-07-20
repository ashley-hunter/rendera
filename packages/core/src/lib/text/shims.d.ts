// Minimal ambient types for the untyped text deps we use.

declare module 'bidi-js' {
  export interface EmbeddingLevels {
    levels: Uint8Array;
    paragraphs: { start: number; end: number; level: number }[];
  }
  export interface Bidi {
    getEmbeddingLevels(text: string, explicitDirection?: 'ltr' | 'rtl'): EmbeddingLevels;
    getReorderSegments(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number
    ): [number, number][];
    getMirroredCharactersMap(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number
    ): Map<number, string>;
  }
  export default function bidiFactory(): Bidi;
}

declare module 'unicode-properties' {
  interface UnicodeProperties {
    getScript(codePoint: number): string;
    getCategory(codePoint: number): string;
  }
  const props: UnicodeProperties;
  export default props;
}
