/**
 * TokenUsage axis anchor for @archon/core's seam guard (#2674).
 *
 * This lives in `src/test/` rather than beside its assertion in
 * `src/db/workflow-events.test.ts` for one reason: `packages/core/tsconfig.json`
 * excludes `**\/*.test.ts` from type-check (removing that exclusion surfaces
 * ~966 pre-existing errors, so it is load-bearing). An anchor placed in a test
 * file here would never fail, which would make it decoration. `src/test/` is
 * inside `include: ["src/**\/*"]` and is not a `.test.ts` file, so it IS
 * type-checked — the same directory that already holds this package's shared
 * test mocks.
 *
 * Duplicated from the matching block in `@archon/workflows`'
 * `dag-executor.test.ts`. That is deliberate, and NOT because the packages
 * cannot see each other — `@archon/core` depends on `@archon/workflows` and
 * imports it today (the layering ban runs the other way). It is because each
 * copy is what puts its OWN package's `tsc --noEmit` inside the guard: an
 * anchor imported from elsewhere would fail once, in one program, instead of
 * once per package that carries usage. Two literals of the same type cannot
 * silently diverge on the dimension that matters, because both are pinned to
 * `Required<TokenUsage>`.
 */

import type { TokenUsage } from '@archon/providers/types';

/**
 * One value per axis, all distinct so a swapped field fails instead of passing
 * on a coincidence.
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
