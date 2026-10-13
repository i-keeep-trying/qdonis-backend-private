import {
  pyLowerStr,
  pyOr,
  pyStrKey,
  pyTruthy,
  pythonRound,
} from './python-semantics';

describe('python-semantics', () => {
  it.each<[unknown, boolean]>([
    [null, false],
    [undefined, false],
    [false, false],
    [0, false],
    [-0, false],
    ['', false],
    [[], false],
    [{}, false],
    [true, true],
    [1, true],
    [-1e-300, true],
    [Number.NaN, true],
    ['0', true],
    [' ', true],
    [[0], true],
    [{ a: null }, true],
  ])('pyTruthy(%p) = %p', (value, expected) => {
    expect(pyTruthy(value)).toBe(expected);
  });

  it('pyOr returns the first truthy operand or the second', () => {
    expect(pyOr(0, 'b')).toBe('b');
    expect(pyOr('a', 'b')).toBe('a');
    expect(pyOr(null, undefined)).toBeUndefined();
  });

  it('pyLowerStr is str(v or "").lower()', () => {
    expect(pyLowerStr(null)).toBe('');
    expect(pyLowerStr('PWM_Control')).toBe('pwm_control');
    expect(pyLowerStr(true)).toBe('true');
    expect(pyLowerStr(0)).toBe('');
    expect(pyLowerStr(1.5)).toBe('1.5');
  });

  it('pyStrKey is Python str() of a scalar', () => {
    expect(pyStrKey(null)).toBe('None');
    expect(pyStrKey(undefined)).toBe('None');
    expect(pyStrKey(true)).toBe('True');
    expect(pyStrKey(false)).toBe('False');
    expect(pyStrKey(5)).toBe('5');
    expect(pyStrKey(1e-5)).toBe('1e-05');
    expect(pyStrKey('Q1')).toBe('Q1');
  });

  it('pythonRound is half-even on the exact binary value', () => {
    // 0.0078125 = 2^-7 is an exact tie at the 7th decimal.
    expect(pythonRound(1000.0078125, 6)).toBe(1000.007812);
    expect(pythonRound(1000.0234375, 6)).toBe(1000.023438);
    expect(pythonRound(-1000.0078125, 6)).toBe(-1000.007812);
    // Not a tie: the double of 1/3e-5 lies just below ...3333.
    expect(pythonRound(1 / 3e-5, 6)).toBe(33333.333333);
    expect(pythonRound(1 / 1e-5, 6)).toBe(100000);
    expect(pythonRound(1 / 7e-6, 6)).toBe(142857.142857);
    // The double of 999999.9999995 lies just below the tie (Python agrees).
    expect(pythonRound(999999.9999995, 6)).toBe(999999.999999);
  });
});
