import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export type Kind = "user" | "talk" | "tool" | "echo" | "note";
export type Message = { i: number; kind: Kind; text: string; size: number; date: string };
export type Node = { l: number; i: number; text: string; size: number };

export function open(dir: string) {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "optchat.sqlite"), { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL"); // every commit is fsynced before returning
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    i INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
    size INTEGER NOT NULL, date TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS nodes (
    l INTEGER NOT NULL, i INTEGER NOT NULL, text TEXT NOT NULL,
    size INTEGER NOT NULL, PRIMARY KEY (l, i))`);
  return db;
}

// One writer per chat: hold a Unix socket for the life of the process. A second
// process that can connect exits; a socket that refuses connections is stale.
export async function lock(dir: string) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "lock");
  const held = await Bun.connect({ unix: path, socket: { data() {} } }).then(
    (s) => (s.end(), true),
    () => false,
  );
  if (held) throw new Error(`Another optchat process is using ${dir}.`);
  rmSync(path, { force: true });
  const server = Bun.listen({ unix: path, socket: { data() {}, open: (s) => void s.end() } });
  return () => {
    server.stop(true);
    rmSync(path, { force: true });
  };
}
