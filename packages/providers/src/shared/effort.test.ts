import { describe, test, expect } from 'bun:test';
import { EFFORT_LADDER, clampEffort, isEffortRung } from './effort';

// The vocabularies the four effort-capable SDKs accept. Codex has the full
// ladder; the rest are contiguous slices.
const CLAUDE = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CODEX = EFFORT_LADDER;
const PI = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const COPILOT = ['low', 'medium', 'high', 'xhigh'] as const;

describe('isEffortRung', () => {
  test('accepts every rung on the ladder and nothing else', () => {
    for (const rung of EFFORT_LADDER) expect(isEffortRung(rung)).toBe(true);
    for (const other of ['off', 'extreme', '', 'HIGH', 3, null, undefined, {}]) {
      expect(isEffortRung(other)).toBe(false);
    }
  });
});

describe('clampEffort', () => {
  test('returns a supported rung unchanged', () => {
    for (const rung of CLAUDE) expect(clampEffort(rung, CLAUDE)).toBe(rung);
    for (const rung of CODEX) expect(clampEffort(rung, CODEX)).toBe(rung);
  });

  test('clamps down to the nearest supported rung', () => {
    // The top of Archon's ladder means "as deep as this model goes", so it
    // lands on each provider's strongest rung rather than disappearing.
    expect(clampEffort('ultra', CLAUDE)).toBe('max');
    expect(clampEffort('ultra', PI)).toBe('max');
    expect(clampEffort('ultra', COPILOT)).toBe('xhigh');
    expect(clampEffort('max', COPILOT)).toBe('xhigh');
    expect(clampEffort('max', PI)).toBe('max');
  });

  test('clamps up when no weaker rung is supported', () => {
    // No `minimal` on Claude/Copilot — the bottom of the ladder means "as
    // shallow as this model goes".
    expect(clampEffort('minimal', CLAUDE)).toBe('low');
    expect(clampEffort('minimal', COPILOT)).toBe('low');
  });

  test('prefers a weaker rung over a stronger one when both are available', () => {
    // Walking down first is what keeps a clamp from ever silently buying more
    // reasoning than the author asked for, except at the very bottom.
    expect(clampEffort('high', ['low', 'xhigh'] as const)).toBe('low');
  });

  test('returns undefined for a value that is not on the ladder', () => {
    // `off` is a real sentinel in Pi/Copilot's node config, handled by the
    // caller before the clamp — the clamp itself must not invent a rung for it.
    expect(clampEffort('off', CODEX)).toBeUndefined();
    expect(clampEffort('extreme', CLAUDE)).toBeUndefined();
    expect(clampEffort(undefined, CLAUDE)).toBeUndefined();
    expect(clampEffort(5, CLAUDE)).toBeUndefined();
  });

  test('returns undefined when the provider supports nothing', () => {
    expect(clampEffort('high', [] as const)).toBeUndefined();
  });

  test('every rung resolves to something on every real provider vocabulary', () => {
    for (const vocabulary of [CLAUDE, CODEX, PI, COPILOT]) {
      for (const rung of EFFORT_LADDER) {
        expect(vocabulary as readonly string[]).toContain(clampEffort(rung, vocabulary) as string);
      }
    }
  });
});
