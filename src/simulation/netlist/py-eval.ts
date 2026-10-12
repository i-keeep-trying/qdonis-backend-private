/**
 * The arithmetic subset of Python's `eval()` the netlist generator used for
 * `{...}` / `{{...}}` expressions in YAML spice commands, with the same
 * names (`log10`, `log`, `sin`, `cos`, `sqrt`, `pi`, `e`) and the same int /
 * float rules. Anything else raises, as `eval` with empty builtins did.
 * Nothing is executed: the input is tokenised and evaluated here.
 */

import { PyError, pyStr } from './py';

export type PyNumber = number | bigint;

type Token =
  | { kind: 'num'; value: PyNumber }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string };

const NUMBER =
  /^(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*(?:[eE][-+]?\d(?:_?\d)*)?|\d(?:_?\d)*\.(?:[eE][-+]?\d(?:_?\d)*)?|\d(?:_?\d)*[eE][-+]?\d(?:_?\d)*|0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|[1-9](?:_?\d)*|0(?:_?0)*)/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const OPS = ['**', '//', '+', '-', '*', '/', '%', '(', ')', ',', '~'];

const syntax = (detail: string) => new PyError('SyntaxError', detail);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let rest = source.replace(/^[ \t]+/, '');
  while (rest.length > 0) {
    const number = NUMBER.exec(rest);
    if (number) {
      const text = number[0].replace(/_/g, '');
      const next = rest.slice(number[0].length);
      if (/^[A-Za-z0-9_.]/.test(next)) throw syntax('invalid decimal literal');
      if (/^0[xXoObB]/.test(text)) {
        tokens.push({
          kind: 'num',
          value: BigInt(text.toLowerCase().replace(/^0o/, '0o')),
        });
      } else if (/[.eE]/.test(text)) {
        tokens.push({ kind: 'num', value: Number(text) });
      } else {
        tokens.push({ kind: 'num', value: BigInt(text) });
      }
      rest = next;
    } else if (NAME.test(rest)) {
      const name = (NAME.exec(rest) as RegExpExecArray)[0];
      tokens.push({ kind: 'name', value: name });
      rest = rest.slice(name.length);
    } else {
      const op = OPS.find((candidate) => rest.startsWith(candidate));
      if (!op) throw syntax(`invalid character '${rest[0]}'`);
      tokens.push({ kind: 'op', value: op });
      rest = rest.slice(op.length);
    }
    rest = rest.replace(/^[ \t]+/, '');
  }
  return tokens;
}

const isInt = (value: PyNumber): value is bigint => typeof value === 'bigint';
const toNum = (value: PyNumber): number => Number(value);

function floatResult(value: number): number {
  return value;
}

function floorDivInt(a: bigint, b: bigint): bigint {
  if (b === 0n)
    throw new PyError(
      'ZeroDivisionError',
      'integer division or modulo by zero',
    );
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function modInt(a: bigint, b: bigint): bigint {
  if (b === 0n)
    throw new PyError('ZeroDivisionError', 'integer modulo by zero');
  const r = a % b;
  return r !== 0n && r < 0n !== b < 0n ? r + b : r;
}

function modFloat(a: number, b: number): number {
  if (b === 0) throw new PyError('ZeroDivisionError', 'float modulo');
  const r = a % b;
  return r !== 0 && r < 0 !== b < 0 ? r + b : r;
}

function binary(op: string, a: PyNumber, b: PyNumber): PyNumber {
  if (isInt(a) && isInt(b)) {
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        if (b === 0n)
          throw new PyError('ZeroDivisionError', 'division by zero');
        return floatResult(Number(a) / Number(b));
      case '//':
        return floorDivInt(a, b);
      case '%':
        return modInt(a, b);
      case '**':
        if (b < 0n) {
          if (a === 0n) {
            throw new PyError(
              'ZeroDivisionError',
              '0.0 cannot be raised to a negative power',
            );
          }
          return Number(a) ** Number(b);
        }
        if (b > 10_000n)
          throw new PyError('OverflowError', 'exponent too large');
        return a ** b;
    }
  }
  const x = toNum(a);
  const y = toNum(b);
  switch (op) {
    case '+':
      return x + y;
    case '-':
      return x - y;
    case '*':
      return x * y;
    case '/':
      if (y === 0)
        throw new PyError('ZeroDivisionError', 'float division by zero');
      return x / y;
    case '//':
      if (y === 0)
        throw new PyError('ZeroDivisionError', 'float floor division by zero');
      return Math.floor(x / y);
    case '%':
      return modFloat(x, y);
    case '**': {
      if (x === 0 && y < 0) {
        throw new PyError(
          'ZeroDivisionError',
          '0.0 cannot be raised to a negative power',
        );
      }
      if (x < 0 && !Number.isInteger(y)) {
        throw new PyError('ValueError', 'complex result not supported');
      }
      const result = x ** y;
      if (
        !Number.isFinite(result) &&
        Number.isFinite(x) &&
        Number.isFinite(y)
      ) {
        throw new PyError('OverflowError', 'Numerical result out of range');
      }
      return result;
    }
  }
  throw syntax(`unsupported operator ${op}`);
}

const domain = () => new PyError('ValueError', 'math domain error');

const FUNCTIONS: Record<string, (args: PyNumber[]) => PyNumber> = {
  log10: ([x, ...more]) => {
    if (x === undefined || more.length)
      throw new PyError('TypeError', 'log10() takes exactly one argument');
    const v = toNum(x);
    if (v <= 0) throw domain();
    return Math.log10(v);
  },
  log: ([x, base, ...more]) => {
    if (x === undefined || more.length)
      throw new PyError('TypeError', 'log expected 1 or 2 arguments');
    const v = toNum(x);
    if (v <= 0) throw domain();
    if (base === undefined) return Math.log(v);
    const b = toNum(base);
    if (b <= 0) throw domain();
    const denominator = Math.log(b);
    if (denominator === 0)
      throw new PyError('ZeroDivisionError', 'float division by zero');
    return Math.log(v) / denominator;
  },
  sin: ([x, ...more]) => {
    if (x === undefined || more.length)
      throw new PyError('TypeError', 'sin() takes exactly one argument');
    return Math.sin(toNum(x));
  },
  cos: ([x, ...more]) => {
    if (x === undefined || more.length)
      throw new PyError('TypeError', 'cos() takes exactly one argument');
    return Math.cos(toNum(x));
  },
  sqrt: ([x, ...more]) => {
    if (x === undefined || more.length)
      throw new PyError('TypeError', 'sqrt() takes exactly one argument');
    const v = toNum(x);
    if (v < 0) throw domain();
    return Math.sqrt(v);
  },
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Names and functions visible to an evaluation (Python `eval` globals). */
export interface EvalEnv {
  functions: Record<string, (args: PyNumber[]) => PyNumber>;
  names: Record<string, unknown>;
}

const DEFAULT_ENV: EvalEnv = { functions: FUNCTIONS, names: CONSTANTS };

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly env: EvalEnv = DEFAULT_ENV,
  ) {}

  parse(): PyNumber {
    if (this.tokens.length === 0) throw syntax('invalid syntax');
    const value = this.sum();
    if (this.index < this.tokens.length) {
      if (this.peekOp(',')) throw new PyError('TypeError', 'tuple result');
      throw syntax('invalid syntax');
    }
    return value;
  }

  private peekOp(op: string): boolean {
    const token = this.tokens[this.index];
    return token?.kind === 'op' && token.value === op;
  }

  private takeOp(...ops: string[]): string | null {
    const token = this.tokens[this.index];
    if (token?.kind === 'op' && ops.includes(token.value)) {
      this.index += 1;
      return token.value;
    }
    return null;
  }

  private sum(): PyNumber {
    let value = this.term();
    for (let op = this.takeOp('+', '-'); op; op = this.takeOp('+', '-')) {
      value = binary(op, value, this.term());
    }
    return value;
  }

  private term(): PyNumber {
    let value = this.factor();
    for (
      let op = this.takeOp('*', '/', '//', '%');
      op;
      op = this.takeOp('*', '/', '//', '%')
    ) {
      value = binary(op, value, this.factor());
    }
    return value;
  }

  private factor(): PyNumber {
    const op = this.takeOp('+', '-', '~');
    if (!op) return this.power();
    const value = this.factor();
    if (op === '+') return value;
    if (op === '-') return isInt(value) ? -value : -value;
    if (!isInt(value))
      throw new PyError('TypeError', "bad operand type for unary ~: 'float'");
    return ~value;
  }

  private power(): PyNumber {
    const base = this.primary();
    if (this.takeOp('**')) return binary('**', base, this.factor());
    return base;
  }

  private primary(): PyNumber {
    const token = this.tokens[this.index];
    if (!token) throw syntax('unexpected EOF while parsing');
    this.index += 1;
    if (token.kind === 'num') return token.value;
    if (token.kind === 'name') {
      if (this.peekOp('(')) {
        this.index += 1;
        const args: PyNumber[] = [];
        if (!this.takeOp(')')) {
          do args.push(this.sum());
          while (this.takeOp(','));
          if (!this.takeOp(')')) throw syntax("'(' was never closed");
        }
        const fn = Object.hasOwn(this.env.functions, token.value)
          ? this.env.functions[token.value]
          : undefined;
        if (!fn) {
          throw new PyError(
            'NameError',
            `name '${token.value}' is not defined`,
          );
        }
        return fn(args);
      }
      if (Object.hasOwn(this.env.names, token.value)) {
        const value = this.env.names[token.value];
        if (typeof value === 'number' || typeof value === 'bigint')
          return value;
        if (typeof value === 'boolean') return value ? 1n : 0n;
        throw new PyError(
          'TypeError',
          `unsupported operand type for '${token.value}'`,
        );
      }
      // Keywords, so they exist even with empty builtins.
      if (token.value === 'True') return 1n;
      if (token.value === 'False') return 0n;
      if (Object.hasOwn(this.env.functions, token.value)) {
        throw new PyError('TypeError', 'function value is not a number');
      }
      throw new PyError('NameError', `name '${token.value}' is not defined`);
    }
    if (token.value === '(') {
      const value = this.sum();
      if (this.takeOp(',')) throw new PyError('TypeError', 'tuple result');
      if (!this.takeOp(')')) throw syntax("'(' was never closed");
      return value;
    }
    throw syntax('invalid syntax');
  }
}

/** `eval(expression, {"__builtins__": {}}, math names)` for arithmetic. */
export function pyEval(expression: string): PyNumber {
  const source = expression.trim();
  return new Parser(tokenize(source)).parse();
}

/** `eval(expression, env)` with caller-supplied names and functions. */
export function pyEvalWith(expression: string, env: EvalEnv): PyNumber {
  return new Parser(tokenize(expression.trim()), env).parse();
}

const one = (name: string, args: PyNumber[]): PyNumber => {
  if (args.length !== 1)
    throw new PyError('TypeError', `${name}() takes exactly one argument`);
  return args[0];
};

const pyMaxMin =
  (wantMax: boolean) =>
  (args: PyNumber[]): PyNumber => {
    if (args.length === 0)
      throw new PyError('TypeError', 'expected at least 1 argument, got 0');
    if (args.length === 1)
      throw new PyError('TypeError', "'float' object is not iterable");
    let best = args[0];
    for (const value of args.slice(1)) {
      if (wantMax ? value > best : value < best) best = value;
    }
    return best;
  };

const finiteResult = (input: number, result: number): number => {
  if (!Number.isFinite(result) && Number.isFinite(input)) {
    throw new PyError('OverflowError', 'math range error');
  }
  return result;
};

/** Functions of the results / feasibility `eval` (abs, max, min, sqrt, pow, log, log10, exp, sin, cos, tan). */
export const RESULT_FUNCTIONS: Record<string, (args: PyNumber[]) => PyNumber> =
  {
    ...FUNCTIONS,
    abs: (args) => {
      const x = one('abs', args);
      return typeof x === 'bigint' ? (x < 0n ? -x : x) : Math.abs(x);
    },
    max: pyMaxMin(true),
    min: pyMaxMin(false),
    pow: (args) => {
      if (args.length !== 2)
        throw new PyError('TypeError', 'pow expected 2 arguments');
      return binary('**', args[0], args[1]);
    },
    exp: (args) => {
      const x = Number(one('exp', args));
      return finiteResult(x, Math.exp(x));
    },
    tan: (args) => Math.tan(Number(one('tan', args))),
  };

export const RESULT_CONSTANTS: Record<string, number> = { ...CONSTANTS };

/** `str(eval(expression))`. */
export const pyEvalStr = (expression: string): string =>
  pyStr(pyEval(expression));
