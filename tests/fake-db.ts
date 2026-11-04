/**
 * A tiny in-memory stand-in for the Supabase query builder, enough for
 * service-level tests: select / insert / update with eq, is, in, gte, lte,
 * order, limit, range, single, maybeSingle and count. Embedded selects such as
 * "*, goal:goals(*)" resolve `<name>_id` against the named table.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";

type Row = Record<string, any>;

export class FakeDb {
  tables: Record<string, Row[]> = {};
  constructor(seed: Record<string, Row[]> = {}) {
    for (const [k, v] of Object.entries(seed)) this.tables[k] = v.map((r) => ({ ...r }));
  }
  rows(t: string) {
    return (this.tables[t] ??= []);
  }
  from(table: string) {
    return new Query(this, table);
  }
}

class Query implements PromiseLike<any> {
  private filters: ((r: Row) => boolean)[] = [];
  private orders: { col: string; asc: boolean }[] = [];
  private lim: number | null = null;
  private rangeFrom = 0;
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private conflict = "id";
  private payload: any = null;
  private cols = "*";
  private countOnly = false;
  private mode: "many" | "single" | "maybe" = "many";
  private returning = false;
  constructor(
    private db: FakeDb,
    private table: string,
  ) {}
  select(cols = "*", opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") this.cols = cols;
    else this.returning = true;
    if (opts?.head) this.countOnly = true;
    return this;
  }
  insert(v: any) {
    this.op = "insert";
    this.payload = v;
    return this;
  }
  update(v: any) {
    this.op = "update";
    this.payload = v;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  upsert(v: any, o?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = v;
    this.conflict = o?.onConflict ?? "id";
    return this;
  }
  eq(c: string, v: any) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  is(c: string, v: any) {
    this.filters.push((r) => (r[c] ?? null) === v);
    return this;
  }
  in(c: string, v: any[]) {
    this.filters.push((r) => v.includes(r[c]));
    return this;
  }
  gte(c: string, v: any) {
    this.filters.push((r) => r[c] >= v);
    return this;
  }
  lt(c: string, v: any) {
    this.filters.push((r) => r[c] < v);
    return this;
  }
  lte(c: string, v: any) {
    this.filters.push((r) => r[c] <= v);
    return this;
  }
  order(col: string, o?: { ascending?: boolean }) {
    this.orders.push({ col, asc: o?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  range(a: number, b: number) {
    this.rangeFrom = a;
    this.lim = b - a + 1;
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }
  private embed(r: Row, cols = this.cols): Row {
    const out = { ...r };
    // alias:table(inner), with nested embeds inside inner
    let i = 0;
    while (i < cols.length) {
      const m = /(\w+):(\w+)\(/.exec(cols.slice(i));
      if (!m) break;
      const start = i + m.index + m[0].length;
      let depth = 1;
      let j = start;
      while (j < cols.length && depth) {
        if (cols[j] === "(") depth++;
        else if (cols[j] === ")") depth--;
        j++;
      }
      const [, alias, table] = m;
      const inner = cols.slice(start, j - 1);
      const found = this.db.rows(table).find((x) => x.id === r[`${alias}_id`]);
      out[alias] = found ? this.embed(found, inner) : null;
      i = j;
    }
    return out;
  }
  private run(): { data: any; error: any; count?: number } {
    const all = this.db.rows(this.table);
    if (this.op === "insert") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r: Row) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...r }));
      all.push(...list);
      return this.shape(list);
    }
    if (this.op === "upsert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const p of list) {
        const ex = all.find((r) => r[this.conflict] === p[this.conflict]);
        if (ex) Object.assign(ex, p);
        else all.push({ id: randomUUID(), ...p });
      }
      return { data: null, error: null };
    }
    let rows = all.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "delete") {
      this.db.tables[this.table] = all.filter((r) => !rows.includes(r));
      return this.returning ? this.shape(rows) : { data: null, error: null };
    }
    if (this.op === "update") {
      for (const r of rows) Object.assign(r, this.payload);
      return this.returning ? this.shape(rows) : { data: null, error: null };
    }
    if (this.countOnly) return { data: null, error: null, count: rows.length };
    for (const o of [...this.orders].reverse()) rows = [...rows].sort((a, b) => (a[o.col] < b[o.col] ? -1 : a[o.col] > b[o.col] ? 1 : 0) * (o.asc ? 1 : -1));
    rows = rows.slice(this.rangeFrom, this.lim == null ? undefined : this.rangeFrom + this.lim);
    return this.shape(rows.map((r) => this.embed(r)));
  }
  private shape(rows: Row[]) {
    if (this.mode === "many") return { data: rows, error: null };
    if (this.mode === "single" && rows.length !== 1) return { data: null, error: { message: `expected one row, got ${rows.length}` } };
    return { data: rows[0] ?? null, error: null };
  }
  then<A, B>(ok?: ((v: any) => A | PromiseLike<A>) | null, bad?: ((e: any) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(ok, bad);
  }
}
