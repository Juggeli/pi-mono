/**
 * Edit ordering utilities for hashline edits.
 *
 * Re-exports from hashline.ts for organizational clarity.
 * The actual implementations live in hashline.ts to avoid circular dependencies.
 */

export { collectLineRefs, detectOverlappingRanges, getEditLineNumber } from "./hashline.js";
