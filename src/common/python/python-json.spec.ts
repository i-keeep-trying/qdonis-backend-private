import {
  pythonFloatRepr,
  pythonJsonDumps,
  pythonNumber,
  pythonStr,
  pythonStrip,
  truncateCodePoints,
} from './python-json';

describe('python-json', () => {
  it.each([
    [0.00001, '1e-05'],
    [0.000001, '1e-06'],
    [1e-7, '1e-07'],
    [0.0001, '0.0001'],
    [1.5, '1.5'],
    [-0.5, '-0.5'],
    [123.456, '123.456'],
    [3.141592653589793, '3.141592653589793'],
    [1e21, '1e+21'],
    [1.5e22, '1.5e+22'],
    [2.5e-10, '2.5e-10'],
    [1e16, '1e+16'],
    [12345.0, '12345.0'],
    [0, '0.0'],
  ])('pythonFloatRepr(%p) = %s', (value, expected) => {
    expect(pythonFloatRepr(value)).toBe(expected);
  });

  it('prints JS integers as Python ints', () => {
    expect(pythonNumber(5)).toBe('5');
    expect(pythonNumber(-3)).toBe('-3');
    expect(pythonNumber(1e20)).toBe('100000000000000000000');
    expect(pythonNumber(1e21)).toBe('1e+21');
    expect(pythonNumber(0.5)).toBe('0.5');
  });

  it('dumps with Python separators and ensure_ascii=False', () => {
    expect(
      pythonJsonDumps({
        a: [1, 2.5, null, true, false],
        b: { c: 'µ — 🔌 "q" \\ \n\t\u0001' },
        skipped: undefined,
        empty: {},
        list: [],
      }),
    ).toBe(
      '{"a": [1, 2.5, null, true, false], "b": {"c": "µ — 🔌 \\"q\\" \\\\ \\n\\t\\u0001"}, "empty": {}, "list": []}',
    );
  });

  it('str() of scalars', () => {
    expect(pythonStr(true)).toBe('True');
    expect(pythonStr(false)).toBe('False');
    expect(pythonStr(null)).toBe('');
    expect(pythonStr(undefined)).toBe('');
    expect(pythonStr(0.00001)).toBe('1e-05');
    expect(pythonStr(42)).toBe('42');
    expect(pythonStr('x')).toBe('x');
  });

  it('strips Python whitespace, not U+FEFF', () => {
    expect(pythonStrip('\u001f a \u0085')).toBe('a');
    expect(pythonStrip('\ufeffa')).toBe('\ufeffa');
    expect(pythonStrip(' \u00a0\u2003 ')).toBe('');
  });

  it('truncates by code points', () => {
    expect(truncateCodePoints('abc', 3, '…')).toBe('abc');
    expect(truncateCodePoints('ab🔌c', 3, '…')).toBe('ab🔌…');
    expect(truncateCodePoints('🔌🔋', 1, '')).toBe('🔌');
  });
});
