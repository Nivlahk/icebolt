export type TokenKind = 'ident' | 'string' | 'number' | 'expr' | 'punct' | 'eof';

export interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  /** True for `"double quoted"` identifiers. */
  quoted: boolean;
}

export class DbmlSyntaxError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`DBML syntax error (line ${line}): ${message}`);
    this.name = 'DbmlSyntaxError';
    this.line = line;
  }
}

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;
const DIGIT = /[0-9]/;
const NUMBER_RE = /-?\d+(?:\.\d+)?/y;

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** DBML triple-quoted strings strip the common leading indentation. */
function dedent(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  if (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const lead = /^[ \t]*/.exec(line)![0].length;
    indent = Math.min(indent, lead);
  }
  if (!Number.isFinite(indent)) indent = 0;
  return lines.map((l) => l.slice(indent)).join('\n');
}

function readEscaped(src: string, start: number, quote: string, line: number): { value: string; end: number; lines: number } {
  let out = '';
  let j = start;
  let lines = 0;
  while (j < src.length && src[j] !== quote) {
    const c = src[j]!;
    if (c === '\\' && j + 1 < src.length) {
      const nx = src[j + 1]!;
      out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === 'r' ? '\r' : nx;
      j += 2;
      continue;
    }
    if (c === '\n') lines++;
    out += c;
    j++;
  }
  if (j >= src.length) throw new DbmlSyntaxError(`unterminated ${quote === '"' ? 'quoted identifier' : 'string'}`, line);
  return { value: out, end: j + 1, lines };
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;

  const push = (kind: TokenKind, value: string, atLine = line, quoted = false): void => {
    tokens.push({ kind, value, line: atLine, quoted });
  };

  while (i < n) {
    const ch = src[i]!;

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '﻿') {
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new DbmlSyntaxError('unterminated block comment', line);
      line += countNewlines(src.slice(i, end));
      i = end + 2;
      continue;
    }
    if (src.startsWith("'''", i)) {
      const end = src.indexOf("'''", i + 3);
      if (end < 0) throw new DbmlSyntaxError('unterminated triple-quoted string', line);
      const raw = src.slice(i + 3, end);
      push('string', dedent(raw));
      line += countNewlines(raw);
      i = end + 3;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const startLine = line;
      const r = readEscaped(src, i + 1, ch, line);
      if (ch === "'") push('string', r.value, startLine);
      else push('ident', r.value, startLine, true);
      line += r.lines;
      i = r.end;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) throw new DbmlSyntaxError('unterminated backtick expression', line);
      const raw = src.slice(i + 1, end);
      push('expr', raw.trim());
      line += countNewlines(raw);
      i = end + 1;
      continue;
    }

    const prev = tokens[tokens.length - 1];
    const negativeAllowed =
      ch === '-' &&
      DIGIT.test(src[i + 1] ?? '') &&
      prev !== undefined &&
      prev.kind === 'punct' &&
      (prev.value === ':' || prev.value === ',' || prev.value === '(');
    if (DIGIT.test(ch) || negativeAllowed) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(src);
      if (m) {
        push('number', m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(src[j]!)) j++;
      push('ident', src.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '<' && src[i + 1] === '>') {
      push('punct', '<>');
      i += 2;
      continue;
    }

    push('punct', ch);
    i++;
  }

  push('eof', '');
  return tokens;
}
