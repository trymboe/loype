/**
 * Version identifiers for every derivation. Bump a version whenever the
 * algorithm's output could change, so stored values can be traced and
 * recomputed. See docs/ANALYTICS.md for the methods.
 */
export const VERSIONS = {
  fitParser: "fit-parser@1",
  movingTime: "moving-time@1",
  splits: "splits@2",
  quality: "quality@1",
  dedupe: "dedupe@1",
} as const;
