import type {
  DbmlColumn,
  DbmlDefault,
  DbmlDocument,
  DbmlEndpoint,
  DbmlEnum,
  DbmlIndex,
  DbmlIndexPart,
  DbmlInlineRef,
  DbmlReferentialAction,
  DbmlRef,
  DbmlTable,
  RefOp,
} from './ast.js';
import { DbmlSyntaxError, tokenize, type Token } from './tokenizer.js';

interface Setting {
  key: string;
  value: Token[];
  line: number;
}

const REF_OPS: ReadonlySet<string> = new Set(['>', '<', '-', '<>']);
const REF_ACTIONS: ReadonlySet<string> = new Set(['cascade', 'restrict', 'set null', 'set default', 'no action']);

function describe(tok: Token): string {
  if (tok.kind === 'eof') return 'end of input';
  if (tok.kind === 'string') return `string '${tok.value.slice(0, 20)}'`;
  return `'${tok.value}'`;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  next(): Token {
    const tok = this.peek();
    if (tok.kind !== 'eof') this.pos++;
    return tok;
  }

  atEnd(): boolean {
    return this.peek().kind === 'eof';
  }

  isPunct(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'punct' && t.value === value;
  }

  isKeyword(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'ident' && !t.quoted && t.value.toLowerCase() === word;
  }

  expectPunct(value: string): Token {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new DbmlSyntaxError(`expected '${value}' but found ${describe(tok)}`, tok.line);
    }
    return tok;
  }

  expectName(what: string): string {
    const tok = this.next();
    if (tok.kind !== 'ident') throw new DbmlSyntaxError(`expected ${what} but found ${describe(tok)}`, tok.line);
    return tok.value;
  }

  expectString(what: string): string {
    const tok = this.next();
    if (tok.kind !== 'string') throw new DbmlSyntaxError(`expected ${what} (a quoted string) but found ${describe(tok)}`, tok.line);
    return tok.value;
  }

  // ---------------------------------------------------------------- document

  parseDocument(): DbmlDocument {
    const doc: DbmlDocument = { tables: [], enums: [], refs: [] };
    while (!this.atEnd()) {
      const tok = this.peek();
      if (this.isKeyword('table')) doc.tables.push(this.parseTable());
      else if (this.isKeyword('enum')) doc.enums.push(this.parseEnum());
      else if (this.isKeyword('ref')) doc.refs.push(...this.parseRef());
      else if (tok.kind === 'ident') this.skipBlock();
      else throw new DbmlSyntaxError(`unexpected ${describe(tok)} at top level`, tok.line);
    }
    return doc;
  }

  /** Project, TableGroup, Note, Records, TablePartial … — not needed for compilation. */
  private skipBlock(): void {
    const start = this.next();
    while (!this.isPunct('{')) {
      if (this.atEnd()) throw new DbmlSyntaxError(`expected '{' after '${start.value}'`, start.line);
      this.next();
    }
    this.skipBalanced('{', '}');
  }

  private skipBalanced(open: string, close: string): void {
    const startTok = this.expectPunct(open);
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.kind === 'eof') throw new DbmlSyntaxError(`unclosed '${open}'`, startTok.line);
      if (t.kind === 'punct' && t.value === open) depth++;
      else if (t.kind === 'punct' && t.value === close) depth--;
    }
  }

  private parseQualifiedName(what: string): { schema?: string; name: string } {
    const first = this.expectName(what);
    if (this.isPunct('.') && this.peek(1).kind === 'ident') {
      this.next();
      return { schema: first, name: this.expectName(what) };
    }
    return { name: first };
  }

  // ------------------------------------------------------------------ tables

  private parseTable(): DbmlTable {
    const kw = this.next();
    const { schema, name } = this.parseQualifiedName('table name');
    const table: DbmlTable = { name, columns: [], indexes: [], line: kw.line };
    if (schema !== undefined) table.schema = schema;
    if (this.isKeyword('as')) {
      this.next();
      table.alias = this.expectName('table alias');
    }
    if (this.isPunct('[')) this.parseSettings(); // headercolor, note — presentation only
    this.expectPunct('{');

    while (!this.isPunct('}')) {
      if (this.atEnd()) throw new DbmlSyntaxError(`unclosed table '${name}'`, kw.line);
      if (this.isKeyword('note') && (this.isPunct(':', 1) || this.isPunct('{', 1))) {
        table.note = this.parseNoteValue();
      } else if (this.isKeyword('indexes') && this.isPunct('{', 1)) {
        table.indexes.push(...this.parseIndexes());
      } else if (this.isPunct('~')) {
        // TablePartial injection (~partial_name). Partials are not expanded here.
        const t = this.next();
        throw new DbmlSyntaxError(`TablePartial injection '~${this.peek().value}' is not supported; inline the columns`, t.line);
      } else {
        table.columns.push(this.parseColumn());
      }
    }
    this.next();
    return table;
  }

  private parseNoteValue(): string {
    this.next(); // Note
    if (this.isPunct(':')) {
      this.next();
      return this.expectString('note text');
    }
    this.expectPunct('{');
    const text = this.expectString('note text');
    this.expectPunct('}');
    return text;
  }

  private parseColumn(): DbmlColumn {
    const nameTok = this.next();
    if (nameTok.kind !== 'ident') throw new DbmlSyntaxError(`expected column name but found ${describe(nameTok)}`, nameTok.line);

    const typeParts: string[] = [this.expectName(`type for column '${nameTok.value}'`)];
    while (this.isPunct('.') && this.peek(1).kind === 'ident') {
      this.next();
      typeParts.push(this.expectName('type name'));
    }
    const typeArgs: string[] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const t = this.next();
        if (t.kind === 'eof') throw new DbmlSyntaxError('unclosed type arguments', nameTok.line);
        if (t.kind === 'punct' && t.value === ',') continue;
        typeArgs.push(t.value);
      }
      this.next();
    }
    let isArray = false;
    if (this.isPunct('[') && this.isPunct(']', 1)) {
      this.next();
      this.next();
      isArray = true;
    }

    const typeName = typeParts[typeParts.length - 1]!;
    const col: DbmlColumn = {
      name: nameTok.value,
      type: typeParts.join('.') + (typeArgs.length ? `(${typeArgs.join(',')})` : '') + (isArray ? '[]' : ''),
      typeName,
      typeArgs,
      isArray,
      pk: false,
      notNull: false,
      unique: false,
      increment: false,
      checks: [],
      inlineRefs: [],
      line: nameTok.line,
    };
    if (typeParts.length > 1) col.typeSchema = typeParts.slice(0, -1).join('.');

    if (this.isPunct('[')) {
      for (const s of this.parseSettings()) this.applyColumnSetting(col, s);
    }
    return col;
  }

  private applyColumnSetting(col: DbmlColumn, s: Setting): void {
    switch (s.key) {
      case 'pk':
      case 'primary key':
        col.pk = true;
        break;
      case 'not null':
        col.notNull = true;
        break;
      case 'null':
        col.notNull = false;
        break;
      case 'unique':
        col.unique = true;
        break;
      case 'increment':
        col.increment = true;
        break;
      case 'default':
        col.default = parseDefault(s);
        break;
      case 'note':
        col.note = singleString(s, 'note');
        break;
      case 'check': {
        const t = s.value[0];
        if (s.value.length !== 1 || t?.kind !== 'expr') throw new DbmlSyntaxError('check: expects a `backtick` expression', s.line);
        col.checks.push(t.value);
        break;
      }
      case 'ref':
        col.inlineRefs.push(parseInlineRef(s));
        break;
      default:
        // Unknown settings (e.g. presentation-only) are ignored on purpose.
        break;
    }
  }

  /** `[key, key: value, multi word key: value]` */
  parseSettings(): Setting[] {
    const open = this.expectPunct('[');
    const out: Setting[] = [];
    for (;;) {
      if (this.isPunct(']')) {
        this.next();
        return out;
      }
      const keyParts: string[] = [];
      const line = this.peek().line;
      while (this.peek().kind === 'ident' && !this.peek().quoted) keyParts.push(this.next().value.toLowerCase());
      if (keyParts.length === 0) throw new DbmlSyntaxError(`expected a setting name but found ${describe(this.peek())}`, this.peek().line);
      let value: Token[] = [];
      if (this.isPunct(':')) {
        this.next();
        value = this.collectSettingValue(open.line);
      }
      out.push({ key: keyParts.join(' '), value, line });
      if (this.isPunct(',')) {
        this.next();
        continue;
      }
      if (!this.isPunct(']')) throw new DbmlSyntaxError(`expected ',' or ']' in settings but found ${describe(this.peek())}`, this.peek().line);
    }
  }

  private collectSettingValue(openLine: number): Token[] {
    const out: Token[] = [];
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.kind === 'eof') throw new DbmlSyntaxError("unclosed '['", openLine);
      if (depth === 0 && t.kind === 'punct' && (t.value === ',' || t.value === ']')) return out;
      if (t.kind === 'punct' && t.value === '(') depth++;
      if (t.kind === 'punct' && t.value === ')') depth--;
      out.push(this.next());
    }
  }

  private parseIndexes(): DbmlIndex[] {
    this.next(); // indexes
    this.expectPunct('{');
    const out: DbmlIndex[] = [];
    while (!this.isPunct('}')) {
      const start = this.peek();
      if (start.kind === 'eof') throw new DbmlSyntaxError('unclosed indexes block', start.line);
      const parts: DbmlIndexPart[] = [];
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          const t = this.next();
          if (t.kind === 'eof') throw new DbmlSyntaxError('unclosed composite index', start.line);
          if (t.kind === 'punct' && t.value === ',') continue;
          if (t.kind === 'ident') parts.push({ kind: 'column', value: t.value });
          else if (t.kind === 'expr') parts.push({ kind: 'expression', value: t.value });
          else throw new DbmlSyntaxError(`unexpected ${describe(t)} in composite index`, t.line);
        }
        this.next();
      } else if (start.kind === 'expr') {
        this.next();
        parts.push({ kind: 'expression', value: start.value });
      } else {
        parts.push({ kind: 'column', value: this.expectName('index column') });
      }
      const idx: DbmlIndex = { parts, pk: false, unique: false, line: start.line };
      if (this.isPunct('[')) {
        for (const s of this.parseSettings()) {
          if (s.key === 'pk' || s.key === 'primary key') idx.pk = true;
          else if (s.key === 'unique') idx.unique = true;
          else if (s.key === 'name') idx.name = singleString(s, 'name');
        }
      }
      out.push(idx);
    }
    this.next();
    return out;
  }

  // ------------------------------------------------------------------- enums

  private parseEnum(): DbmlEnum {
    const kw = this.next();
    const { schema, name } = this.parseQualifiedName('enum name');
    this.expectPunct('{');
    const values: string[] = [];
    while (!this.isPunct('}')) {
      const t = this.next();
      if (t.kind === 'eof') throw new DbmlSyntaxError(`unclosed enum '${name}'`, kw.line);
      if (t.kind !== 'ident' && t.kind !== 'string') throw new DbmlSyntaxError(`invalid enum value ${describe(t)}`, t.line);
      values.push(t.value);
      if (this.isPunct('[')) this.parseSettings();
    }
    this.next();
    const e: DbmlEnum = { name, values, line: kw.line };
    if (schema !== undefined) e.schema = schema;
    return e;
  }

  // -------------------------------------------------------------------- refs

  private parseRef(): DbmlRef[] {
    const kw = this.next();
    let name: string | undefined;
    if (!this.isPunct(':') && !this.isPunct('{')) name = this.expectName('ref name');
    if (this.isPunct(':')) {
      this.next();
      return [this.parseRefBody(name, kw.line)];
    }
    this.expectPunct('{');
    const out: DbmlRef[] = [];
    while (!this.isPunct('}')) {
      if (this.atEnd()) throw new DbmlSyntaxError('unclosed Ref block', kw.line);
      out.push(this.parseRefBody(name, this.peek().line));
    }
    this.next();
    return out;
  }

  private parseRefBody(name: string | undefined, line: number): DbmlRef {
    const left = parseEndpoint(this);
    const opTok = this.next();
    if (opTok.kind !== 'punct' || !REF_OPS.has(opTok.value)) {
      throw new DbmlSyntaxError(`expected relationship operator (>, <, -, <>) but found ${describe(opTok)}`, opTok.line);
    }
    const right = parseEndpoint(this);
    const ref: DbmlRef = { op: opTok.value as RefOp, left, right, line };
    if (name !== undefined) ref.name = name;
    if (this.isPunct('[')) {
      for (const s of this.parseSettings()) {
        if (s.key === 'delete') ref.onDelete = refAction(s);
        else if (s.key === 'update') ref.onUpdate = refAction(s);
      }
    }
    return ref;
  }
}

// ------------------------------------------------------------------ helpers

function parseEndpoint(p: Parser): DbmlEndpoint {
  const line = p.peek().line;
  const parts: string[] = [p.expectName('table or column name')];
  let cols: string[] | null = null;
  while (p.isPunct('.')) {
    p.next();
    if (p.isPunct('(')) {
      p.next();
      cols = [];
      while (!p.isPunct(')')) {
        if (p.isPunct(',')) {
          p.next();
          continue;
        }
        if (p.atEnd()) throw new DbmlSyntaxError('unclosed composite reference', line);
        cols.push(p.expectName('column name'));
      }
      p.next();
      break;
    }
    parts.push(p.expectName('table or column name'));
  }
  if (cols === null) {
    const col = parts.pop();
    if (col === undefined) throw new DbmlSyntaxError('empty reference endpoint', line);
    cols = [col];
  }
  const table = parts.pop();
  if (table === undefined) throw new DbmlSyntaxError(`reference endpoint '${cols.join(',')}' must be qualified as table.column`, line);
  const ep: DbmlEndpoint = { table, columns: cols, line };
  if (parts.length > 0) ep.schema = parts.join('.');
  return ep;
}

function parseInlineRef(s: Setting): DbmlInlineRef {
  const [opTok, ...rest] = s.value;
  if (!opTok || opTok.kind !== 'punct' || !REF_OPS.has(opTok.value)) {
    throw new DbmlSyntaxError('inline ref must start with a relationship operator (>, <, -, <>)', s.line);
  }
  const sub = new Parser([...rest, { kind: 'eof', value: '', line: s.line, quoted: false }]);
  const target = parseEndpoint(sub);
  if (!sub.atEnd()) throw new DbmlSyntaxError(`unexpected ${describe(sub.peek())} in inline ref`, s.line);
  return { op: opTok.value as RefOp, target };
}

function singleString(s: Setting, what: string): string {
  const t = s.value[0];
  if (s.value.length !== 1 || !t || (t.kind !== 'string' && t.kind !== 'ident')) {
    throw new DbmlSyntaxError(`${what}: expects a single quoted string`, s.line);
  }
  return t.value;
}

function parseDefault(s: Setting): DbmlDefault {
  if (s.value.length !== 1) {
    throw new DbmlSyntaxError("default: expects one value ('string', number, true/false, null, or `expression`)", s.line);
  }
  const t = s.value[0]!;
  switch (t.kind) {
    case 'string':
      return { kind: 'string', value: t.value };
    case 'number':
      return { kind: 'number', value: t.value };
    case 'expr':
      return { kind: 'expression', value: t.value };
    case 'ident': {
      const v = t.value.toLowerCase();
      if (!t.quoted && (v === 'true' || v === 'false')) return { kind: 'boolean', value: v };
      if (!t.quoted && v === 'null') return { kind: 'null', value: 'null' };
      throw new DbmlSyntaxError(`default: unrecognized value '${t.value}' (wrap SQL in backticks)`, s.line);
    }
    default:
      throw new DbmlSyntaxError(`default: unexpected ${describe(t)}`, s.line);
  }
}

function refAction(s: Setting): DbmlReferentialAction {
  const v = s.value.map((t) => t.value.toLowerCase()).join(' ');
  if (!REF_ACTIONS.has(v)) throw new DbmlSyntaxError(`unknown referential action '${v}'`, s.line);
  return v as DbmlReferentialAction;
}

/** Parse DBML source into a raw AST. Throws {@link DbmlSyntaxError}. */
export function parseDbml(source: string): DbmlDocument {
  return new Parser(tokenize(source)).parseDocument();
}

export { DbmlSyntaxError };
