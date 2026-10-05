import type { Database } from "bun:sqlite";
import { MARKS, VIEW, bytes } from "./config";
import type { Kind, Message, Node } from "./db";

// A tree node / view part: node (l, i) covers messages [i·2^l, (i+1)·2^l).
export type Part = { l: number; i: number };

export const PENDING = "(not summarized yet: zoom it)";

const key = (l: number, i: number) => `${l}:${i}`;
export const start = (p: Part) => p.i * 2 ** p.l;
export const end = (p: Part) => (p.i + 1) * 2 ** p.l;
export const flat = (s: string) => s.replace(/\r?\n/g, " ");
export const chat = (lines: string[]) => ["<chat>", ...lines, "</chat>"].join("\n");

// The log, the tree and the view, kept in memory and backed by SQLite.
export class Memory {
  root: Message[] = [];
  nodes = new Map<string, string>();
  view: Part[] = [];
  // Called after every fit(), so waiters can check whether the view settled.
  listeners = new Set<() => void>();

  constructor(private db: Database) {
    this.root = db.query("SELECT * FROM messages ORDER BY i").all() as Message[];
    this.root.forEach((m, k) => {
      if (m.i !== k) throw new Error(`Log is missing message ${k}.`);
    });
    for (const n of db.query("SELECT * FROM nodes").all() as Node[]) this.nodes.set(key(n.l, n.i), n.text);
    // The view is never stored: fold it again from message 0.
    for (let i = 0; i < this.root.length; i++) {
      this.view.push({ l: 0, i });
      this.fit(i + 1);
    }
  }

  get T() {
    return this.root.length;
  }

  built(l: number, i: number) {
    return this.nodes.has(key(l, i));
  }

  node(l: number, i: number) {
    return this.nodes.get(key(l, i));
  }

  text(p: Part) {
    return this.node(p.l, p.i) ?? PENDING;
  }

  log(kind: Kind, text: string): Message {
    const m: Message = { i: this.T, kind, text, size: bytes(`${kind}: ${text}`), date: new Date().toISOString() };
    this.db.query("INSERT INTO messages (i, kind, text, size, date) VALUES ($i, $kind, $text, $size, $date)").run(m);
    this.root.push(m);
    this.view.push({ l: 0, i: m.i });
    this.fit();
    return m;
  }

  save(l: number, i: number, text: string) {
    this.db.query("INSERT INTO nodes (l, i, text, size) VALUES ($l, $i, $text, $size)").run({ l, i, text, size: bytes(text) });
    this.nodes.set(key(l, i), text);
    this.fit();
  }

  // Shrink the view under VIEW bytes by merging, one at a time, the most due
  // adjacent pair whose parent is built. Parts are never split.
  fit(T = this.T) {
    let size = 0;
    for (const p of this.view) size += bytes(this.text(p));
    while (size > VIEW) {
      let best = -1;
      let bestDue = -Infinity;
      for (let k = 0; k + 1 < this.view.length; k++) {
        const a = this.view[k]!;
        const b = this.view[k + 1]!;
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1 || !this.built(a.l + 1, a.i / 2)) continue;
        const due = (T - start(a)) / 2 ** (a.l + 2);
        if (due > bestDue) [best, bestDue] = [k, due];
      }
      if (best < 0) break; // wait until a parent is built
      const [a, b] = [this.view[best]!, this.view[best + 1]!];
      const p = { l: a.l + 1, i: a.i / 2 };
      size += bytes(this.text(p)) - bytes(this.text(a)) - bytes(this.text(b));
      this.view.splice(best, 2, p);
    }
    for (const f of this.listeners) f();
  }

  settled() {
    return this.view.every((p) => this.built(p.l, p.i));
  }

  line(p: Part) {
    return `${start(p)}+${2 ** p.l}|${flat(this.text(p))}`;
  }

  // The view as <chat> text, cut into pieces at the last line end before each
  // cache mark, so each piece can carry a cache breakpoint.
  render() {
    const s = chat(this.view.map((p) => this.line(p)));
    const pieces: string[] = [];
    let from = 0;
    for (const mark of MARKS) {
      if (mark >= s.length) break;
      const cut = s.lastIndexOf("\n", mark - 1) + 1;
      if (cut > from) pieces.push(s.slice(from, cut)), (from = cut);
    }
    pieces.push(s.slice(from));
    return pieces;
  }

  // Bare view lines (no ids) of the parts that end at or before message `upto`.
  context(upto: number) {
    return chat(this.view.filter((p) => end(p) <= upto).map((p) => flat(this.text(p))));
  }

  zoom(id: number, n: number) {
    const ok = Number.isInteger(id) && Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0;
    if (!ok || id < 0 || id % n !== 0 || id + n > this.T) return `No line ${id}+${n}.`;
    if (n === 1) {
      const m = this.root[id]!;
      return `${id}+0|${m.kind}: ${m.text}`;
    }
    const l = Math.log2(n) - 1;
    const i = (2 * id) / n;
    return [this.line({ l, i }), this.line({ l, i: i + 1 })].join("\n");
  }

  date(id: number) {
    const m = this.root[id];
    if (!m) return `No message ${id}.`;
    return new Date(m.date).toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" });
  }
}
