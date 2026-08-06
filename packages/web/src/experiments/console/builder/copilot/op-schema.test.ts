import { describe, test, expect } from 'bun:test';
import { parseAndValidateOps } from './op-schema';

describe('parseAndValidateOps', () => {
  test('parses a valid batch', () => {
    const result = parseAndValidateOps(
      JSON.stringify([
        { op: 'addNode', id: 'gate', variant: 'approval', data: { message: 'ok?' } },
        { op: 'connect', source: 'plan', target: 'gate' },
      ])
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops).toHaveLength(2);
      expect(result.ops[0]).toEqual({
        op: 'addNode',
        id: 'gate',
        variant: 'approval',
        data: { message: 'ok?' },
      });
      expect(result.ops[1]).toEqual({ op: 'connect', source: 'plan', target: 'gate' });
    }
  });

  test('rejects invalid JSON', () => {
    const result = parseAndValidateOps('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('invalid JSON');
  });

  test('rejects a non-array payload', () => {
    const result = parseAndValidateOps(JSON.stringify({ op: 'addNode' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('must be a JSON array');
  });

  test('rejects an empty array', () => {
    const result = parseAndValidateOps('[]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('non-empty');
  });

  test('rejects a non-object op entry', () => {
    const result = parseAndValidateOps(JSON.stringify(['not-an-object']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('must be an object');
  });

  test('rejects an unknown op kind', () => {
    const result = parseAndValidateOps(JSON.stringify([{ op: 'deleteEverything' }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown op');
  });

  test('rejects addNode missing id', () => {
    const result = parseAndValidateOps(JSON.stringify([{ op: 'addNode', variant: 'prompt' }]));
    expect(result.ok).toBe(false);
  });

  test('rejects addNode with an unknown variant (uses isVariantId)', () => {
    const result = parseAndValidateOps(
      JSON.stringify([{ op: 'addNode', id: 'x', variant: 'notavariant' }])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown variant');
  });

  test('addNode without data is valid (data is optional)', () => {
    const result = parseAndValidateOps(
      JSON.stringify([{ op: 'addNode', id: 'x', variant: 'prompt' }])
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ops[0]).toEqual({ op: 'addNode', id: 'x', variant: 'prompt' });
  });

  test('rejects connect missing source or target', () => {
    const result = parseAndValidateOps(JSON.stringify([{ op: 'connect', source: 'a' }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('requires source and target');
  });

  test('rejects setField with a path not prefixed data./base.', () => {
    const result = parseAndValidateOps(
      JSON.stringify([{ op: 'setField', id: 'x', path: 'model', value: 'sonnet' }])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must start with 'data.' or 'base.'");
  });

  test('accepts setField with a data. or base. path', () => {
    const result = parseAndValidateOps(
      JSON.stringify([
        { op: 'setField', id: 'x', path: 'data.prompt', value: 'hi' },
        { op: 'setField', id: 'x', path: 'base.model', value: 'sonnet' },
      ])
    );
    expect(result.ok).toBe(true);
  });

  test('rejects rename missing nextId', () => {
    const result = parseAndValidateOps(JSON.stringify([{ op: 'rename', id: 'a' }]));
    expect(result.ok).toBe(false);
  });

  test('rejects remove missing id', () => {
    const result = parseAndValidateOps(JSON.stringify([{ op: 'remove' }]));
    expect(result.ok).toBe(false);
  });

  test('error message identifies the offending op index', () => {
    const result = parseAndValidateOps(
      JSON.stringify([{ op: 'remove', id: 'a' }, { op: 'remove' }])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('op[1]');
  });

  // Regression: before this guard, an id failing NODE_ID_PATTERN was accepted here,
  // then silently replaced by the reducer's synthesized `<variant>-N`. The batch's
  // later ops kept referencing the REQUESTED id, so they applied against a node that
  // was never created — with no issue raised and Accept still enabled.
  describe('node-id pattern (regression: silent reducer substitution)', () => {
    test.each([
      ['a space', 'my gate'],
      ['a leading digit', '2nd-review'],
      ['punctuation', 'check-tests!'],
      ['a leading hyphen', '-gate'],
      ['a dot', 'my.gate'],
    ])('rejects addNode with %s', (_label, id) => {
      const result = parseAndValidateOps(
        JSON.stringify([{ op: 'addNode', id, variant: 'approval' }])
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('must match');
    });

    test.each([
      ['valid snake_case', 'my_gate'],
      ['valid kebab-case', 'my-gate'],
      ['a leading underscore', '_gate'],
    ])('accepts addNode with %s', (_label, id) => {
      const result = parseAndValidateOps(
        JSON.stringify([{ op: 'addNode', id, variant: 'approval' }])
      );
      expect(result.ok).toBe(true);
    });

    test('rejects rename to a pattern-invalid nextId', () => {
      const result = parseAndValidateOps(
        JSON.stringify([{ op: 'rename', id: 'gate', nextId: 'my gate' }])
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('must match');
    });
  });
});
