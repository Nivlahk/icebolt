/**
 * `@ui:` directive extraction from DBML column notes.
 *
 *   note: '''@ui:form-input { label: 'Task', placeholder: 'What needs doing?' }'''
 *   note: '@ui:action-button { action: "toggleRow", target: "status" }'
 *
 * Props use a strict, JSON5-like literal grammar (unquoted or quoted keys,
 * single/double-quoted strings, numbers, booleans, null, arrays, nested
 * objects, trailing commas). Nothing is ever evaluated.
 */

export type UiValue = string | number | boolean | null | UiValue[] | { [key: string]: UiValue };
export type UiProps = Record<string, UiValue>;

export interface UiDirective {
  /** Lower-cased directive name without the `@ui:` prefix, e.g. `form-input`. */
  name: string;
  props: UiProps;
  /** Character offset of the directive inside the note. */
  offset: number;
}

export interface DirectiveParseResult {
  directives: UiDirective[];
  errors: string[];
}

const MAX_DEPTH = 16;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

class LiteralSyntaxError extends Error {}

class LiteralParser {
  i: number;

  constructor(
    private readonly s: string,
    start: number,
  ) {
    this.i = start;
  }

  private fail(msg: string): never {
    throw new LiteralSyntaxError(`${msg} at offset ${this.i}`);
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  parseObject(depth = 0): UiProps {
    if (depth > MAX_DEPTH) this.fail('props nested too deeply');
    if (this.s[this.i] !== '{') this.fail("expected '{'");
    this.i++;
    const out: UiProps = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
      const key = this.parseKey();
      if (FORBIDDEN_KEYS.has(key)) this.fail(`forbidden key '${key}'`);
      if (Object.prototype.hasOwnProperty.call(out, key)) this.fail(`duplicate key '${key}'`);
      this.ws();
      if (this.s[this.i] !== ':') this.fail(`expected ':' after key '${key}'`);
      this.i++;
      out[key] = this.parseValue(depth + 1);
      this.ws();
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === '}') {
        this.i++;
        return out;
      }
      this.fail("expected ',' or '}'");
    }
  }

  private parseKey(): string {
    const c = this.s[this.i];
    if (c === "'" || c === '"') return this.parseString();
    const m = /[A-Za-z_$][A-Za-z0-9_$-]*/y;
    m.lastIndex = this.i;
    const r = m.exec(this.s);
    if (!r) this.fail('expected a property name');
    this.i += r[0].length;
    return r[0];
  }

  private parseValue(depth: number): UiValue {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) this.fail('unexpected end of note');
    if (c === '{') return this.parseObject(depth);
    if (c === '[') return this.parseArray(depth);
    if (c === "'" || c === '"') return this.parseString();
    if (c === '-' || c === '.' || /[0-9]/.test(c)) return this.parseNumber();
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.s.startsWith(word, this.i) && !/[A-Za-z0-9_]/.test(this.s[this.i + word.length] ?? '')) {
        this.i += word.length;
        return value;
      }
    }
    return this.fail('expected a value (strings must be quoted)');
  }

  private parseArray(depth: number): UiValue[] {
    if (depth > MAX_DEPTH) this.fail('props nested too deeply');
    this.i++; // [
    const out: UiValue[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') {
        this.i++;
        return out;
      }
      out.push(this.parseValue(depth + 1));
      this.ws();
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === ']') {
        this.i++;
        return out;
      }
      this.fail("expected ',' or ']'");
    }
  }

  private parseString(): string {
    const quote = this.s[this.i]!;
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === quote) {
        this.i++;
        return out;
      }
      if (c === '\\') {
        const nx = this.s[this.i + 1];
        if (nx === undefined) break;
        if (nx === 'u') {
          const hex = this.s.slice(this.i + 2, this.i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 6;
          continue;
        }
        out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === 'r' ? '\r' : nx;
        this.i += 2;
        continue;
      }
      out += c;
      this.i++;
    }
    return this.fail('unterminated string');
  }

  private parseNumber(): number {
    const m = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
    m.lastIndex = this.i;
    const r = m.exec(this.s);
    if (!r) this.fail('invalid number');
    this.i += r[0].length;
    const n = Number(r[0]);
    if (!Number.isFinite(n)) this.fail('number out of range');
    return n;
  }
}

/** Extract every `@ui:<name> { …props }` directive from a note string. */
export function parseUiDirectives(note: string): DirectiveParseResult {
  const directives: UiDirective[] = [];
  const errors: string[] = [];
  const re = /@ui:([A-Za-z][A-Za-z0-9-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(note)) !== null) {
    const name = m[1]!.toLowerCase();
    let cursor = re.lastIndex;
    while (cursor < note.length && /\s/.test(note[cursor]!)) cursor++;
    let props: UiProps = {};
    if (note[cursor] === '{') {
      const p = new LiteralParser(note, cursor);
      try {
        props = p.parseObject();
        re.lastIndex = p.i;
      } catch (err) {
        errors.push(`@ui:${name}: ${err instanceof Error ? err.message : String(err)}`);
        re.lastIndex = cursor + 1;
        continue;
      }
    }
    directives.push({ name, props, offset: m.index });
  }
  return { directives, errors };
}
