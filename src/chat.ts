import { turn } from "./agent";
import { Compactor } from "./compactor";
import { DIR, VIEW, bytes } from "./config";
import { lock, open } from "./db";
import { Memory, chat, flat } from "./memory";

const USAGE = `usage:
  bun chat "message"      one turn: settle the view, answer, compact, exit
  bun chat -              read the message from stdin
  bun chat --view         print the view the agent sees
  bun chat --zoom ID N    open line ID+N (N = 1: the message whole)
  bun chat --log [FROM]   print the raw log from message FROM on
  bun chat --compact      run the compactor until it has nothing to do
  bun chat --stats        counts of messages, nodes and view

env: OPTCHAT_DIR, OPTCHAT_VIEW (bytes), OPTCHAT_MODEL, OPTCHAT_EFFORT,
     OPTCHAT_COMPACT_MODEL, OPTCHAT_COMPACT_EFFORT, OPTCHAT_BREAKPOINTS=1`;

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(USAGE);
  process.exit(args.length === 0 ? 1 : 0);
}

const unlock = await lock(DIR).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
const exit = (code = 0): never => {
  unlock();
  process.exit(code);
};

const db = open(DIR);
const mem = new Memory(db);
const comp = new Compactor(mem);

function stats() {
  const levels: number[] = [];
  for (const k of mem.nodes.keys()) {
    const l = Number(k.split(":")[0]);
    levels[l] = (levels[l] ?? 0) + 1;
  }
  const size = mem.view.reduce((s, p) => s + bytes(mem.text(p)), 0);
  const pending = mem.view.filter((p) => !mem.built(p.l, p.i)).length;
  return [
    `messages ${mem.T}`,
    `nodes ${[...levels].map((n, l) => `L${l}:${n ?? 0}`).join(" ")}`,
    `view ${mem.view.length} lines, ${size}/${VIEW} B${pending ? `, ${pending} pending` : ""}`,
  ].join(" | ");
}

const cmd = args[0]!;
if (cmd === "--view") {
  console.log(mem.render().join(""));
  exit();
}
if (cmd === "--zoom") {
  console.log(mem.zoom(Number(args[1]), Number(args[2] ?? 1)));
  exit();
}
if (cmd === "--log") {
  const from = Number(args[1] ?? 0);
  console.log(chat(mem.root.slice(from).map((m) => `${m.i}|${m.date}|${m.kind}: ${flat(m.text)}`)));
  exit();
}
if (cmd === "--stats") {
  console.log(stats());
  exit();
}
if (cmd === "--compact") {
  await comp.drain();
  console.error(stats());
  exit();
}

const text = (cmd === "-" ? await Bun.stdin.text() : args.join(" ")).trim();
if (!text) exit(1);

// Ctrl-C: while waiting for the view, keep the message in the log, unanswered;
// during the turn, stop it (everything so far is already logged).
const abort = new AbortController();
let phase: "settle" | "turn" | "drain" = "settle";
process.on("SIGINT", () => {
  if (phase === "settle") mem.log("user", text), console.error("\ncancelled; message logged, unanswered");
  if (phase === "drain") console.error("\ncompactor stopped; it resumes next run");
  if (phase !== "turn") exit(130);
  abort.abort();
});

if (!mem.settled()) console.error("\x1b[2mwaiting for the compactor...\x1b[0m");
await comp.settle();
phase = "turn";
try {
  await turn(mem, comp, text, abort.signal);
} catch (e) {
  if (!abort.signal.aborted) console.error("turn failed:", e instanceof Error ? e.message : e);
}
phase = "drain";
await comp.drain();
console.error(`\x1b[2m${stats()}\x1b[0m`);
exit();
