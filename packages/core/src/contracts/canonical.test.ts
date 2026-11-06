import { describe, expect, it } from 'vitest';
import { CanonicalizationError, canonicalize } from './canonical.js';
import { contentHash, sha256Hex } from './hash.js';

describe('canonicalize (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    // Read the order from the canonical TEXT: Object.keys() after JSON.parse
    // would hoist integer-like keys ("1") regardless of serialization order.
    const keys = [...canonicalize(input).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map(
      (m) => JSON.parse(`"${m[1]}"`) as string,
    );
    expect(keys).toEqual(['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ']);
  });

  it('serializes numbers like ECMAScript (RFC 8785 Appendix B)', () => {
    const cases: Array<[number, string]> = [
      [0, '0'],
      [-0, '0'],
      [5e-324, '5e-324'],
      [1.7976931348623157e308, '1.7976931348623157e+308'],
      [9007199254740992, '9007199254740992'],
      [1e21, '1e+21'],
      [1e-6, '0.000001'],
      [1e-7, '1e-7'],
      [333333333.3333333, '333333333.3333333'],
      [-1.5, '-1.5'],
    ];
    for (const [n, s] of cases) expect(canonicalize(n)).toBe(s);
  });

  it('escapes strings exactly as RFC 8785 requires', () => {
    expect(canonicalize('a"b\\c\n\u0001\u001f€')).toBe('"a\\"b\\\\c\\n\\u0001\\u001f€"');
  });

  it('has no insignificant whitespace and is independent of key insertion order', () => {
    expect(canonicalize({ b: [1, { d: 1, c: 2 }], a: null })).toBe(
      '{"a":null,"b":[1,{"c":2,"d":1}]}',
    );
    expect(contentHash({ x: 1, y: 2 })).toBe(contentHash({ y: 2, x: 1 }));
  });

  it('is idempotent through a JSON round trip', () => {
    const v = { z: [true, false, null, 'é', 1.25], a: { k: 'v' } };
    const once = canonicalize(v);
    expect(canonicalize(JSON.parse(once))).toBe(once);
  });

  const rejects: Array<[string, unknown]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined member', { a: undefined }],
    ['undefined in array', [undefined]],
    ['bigint', 1n],
    ['function', () => 1],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate', 'x\udc00'],
    ['lone surrogate key', { '\ud800': 1 }],
  ];
  for (const [name, v] of rejects) {
    it(`rejects ${name}`, () => expect(() => canonicalize(v)).toThrow(CanonicalizationError));
  }

  it('rejects cycles but allows repeated (acyclic) references', () => {
    const shared = { k: 1 };
    expect(canonicalize({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(/cycle/);
  });

  it('hashes to 64 lowercase hex (known sha256 vector)', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(contentHash('abc')).toBe(sha256Hex(new TextEncoder().encode('"abc"')));
  });
});
