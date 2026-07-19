/**
 * Node identity.
 *
 * `NodeId` is a branded string so ids can't be confused with arbitrary
 * strings at the type level. Id generation is injectable: the default uses a
 * platform UUID when available, and tests/consumers can supply a deterministic
 * factory.
 */

declare const nodeIdBrand: unique symbol;

/** Opaque, unique identifier for a node in a document. */
export type NodeId = string & { readonly [nodeIdBrand]: true };

/** A source of fresh, unique node ids. */
export type IdFactory = () => NodeId;

/** Assert that an existing string is treated as a `NodeId`. */
export function asNodeId(value: string): NodeId {
  return value as NodeId;
}

/**
 * Create the default id factory. Prefers a platform-provided
 * `crypto.randomUUID` (present in modern browsers and Node), read off
 * `globalThis` without depending on any DOM/Node global type. Falls back to a
 * per-factory counter (unique within one factory instance).
 */
export function createIdFactory(): IdFactory {
  const platform = globalThis as {
    crypto?: { randomUUID?: () => string };
  };
  const randomUUID = platform.crypto?.randomUUID?.bind(platform.crypto);
  if (randomUUID) {
    return () => asNodeId(randomUUID());
  }
  let counter = 0;
  return () => asNodeId(`node-${(counter++).toString(36)}`);
}

/**
 * Create a deterministic id factory yielding `${prefix}0`, `${prefix}1`, …
 * Intended for tests and reproducible fixtures.
 */
export function createSequentialIdFactory(prefix = 'node-'): IdFactory {
  let counter = 0;
  return () => asNodeId(`${prefix}${counter++}`);
}
