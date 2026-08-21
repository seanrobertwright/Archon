/**
 * TokenUsage axis seam guard anchors for @archon/core (#2674).
 *
 * These live in `src/test/` rather than beside their assertions in
 * `src/db/workflow-events.test.ts` for one reason: `packages/core/tsconfig.json`
 * excludes `**\/*.test.ts` from type-check (removing that exclusion surfaces 968
 * pre-existing errors, so it is load-bearing). An anchor placed in a test file
 * here would never fail, which would make it decoration. `src/test/` is inside
 * `include: ["src/**\/*"]` and is not a `.test.ts` file, so it IS type-checked —
 * the same directory that already holds this package's shared test mocks.
 *
 * Duplicated from the matching block in `@archon/workflows`'
 * `dag-executor.test.ts` on purpose. Sharing would mean exporting test
 * scaffolding across a package boundary, and each copy is what puts its OWN
 * package's `tsc --noEmit` inside the guard.
 */

import type { TokenUsage } from '@archon/providers/types';

/**
 * One value per axis, all distinct so a swapped key spelling fails instead of
 * passing on a coincidence.
 *
 * `Required<TokenUsage>` is the anchor. Adding `foo?: number` to `TokenUsage`
 * fails here with `TS2741: Property 'foo' is missing in type ... but required in
 * type 'Required<TokenUsage>'`, before any test runs.
 */
export const AXIS_SPECIMEN: Required<TokenUsage> = {
  input: 5000,
  output: 1200,
  cacheRead: 4000,
  cacheWrite: 250,
  cachePartial: true,
  total: 6400,
  cost: 0.25,
};

/**
 * How one seam spells each axis on its wire. `null` = this seam deliberately
 * does not carry the axis. Exhaustive over `keyof TokenUsage`, so a new axis is
 * a compile error until someone decides which it is.
 */
export type SeamAxisKeys = Record<keyof TokenUsage, string | null>;

/**
 * `getDagResumeSnapshot` (`src/db/workflow-events.ts`) rebuilds a persisted
 * `data.tokens` field by field, so an axis it does not know about is dropped
 * from every resumed run's total. Its writer is in `@archon/workflows`, which
 * cannot be imported from here; that half is guarded in that package.
 *
 * `total` and `cost` are `null`. This decoder reads cost from the event's own
 * `data.cost_usd` scalar, never off the usage object — cost is lifted onto the
 * result message's `cost` field back at the provider boundary. And `total` is
 * dropped by the first fold: `mergeTokenUsage` documents that it does not
 * aggregate it, so it never reaches a persisted event to be decoded.
 */
export const RESUME_SNAPSHOT_AXIS_KEYS: SeamAxisKeys = {
  input: 'input',
  output: 'output',
  cacheRead: 'cacheRead',
  cacheWrite: 'cacheWrite',
  cachePartial: 'cachePartial',
  total: null,
  cost: null,
};

/**
 * Assert that every axis `keys` declares carried arrived under its declared key
 * with the specimen's value.
 *
 * Seam and axis ride the compared object's KEY, not a sibling field: bun's diff
 * prints only a narrow window around the changed line, so a sibling `axis` field
 * is elided and the failure never says which axis went missing.
 *
 * `expect` is passed in rather than imported, so this module stays free of
 * `bun:test` and can be type-checked as ordinary source.
 */
export function expectSeamCarriesAxes(
  expect: (actual: unknown) => { toEqual: (expected: unknown) => void },
  seam: string,
  keys: SeamAxisKeys,
  carried: Record<string, unknown> | undefined
): void {
  expect({ [`${seam} carried usage`]: carried !== undefined }).toEqual({
    [`${seam} carried usage`]: true,
  });
  for (const [axis, key] of Object.entries(keys) as [keyof TokenUsage, string | null][]) {
    if (key === null) continue;
    const label = `${seam} → ${axis} (as '${key}')`;
    expect({ [label]: carried?.[key] }).toEqual({ [label]: AXIS_SPECIMEN[axis] });
  }
}
