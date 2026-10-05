import { turn } from "./agent";
import { Compactor } from "./compactor";
import { VIEW, bytes } from "./config";
import { Memory, chat, flat } from "./memory";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// What both front ends can run besides chatting: --NAME on the command line, /NAME in a session.
type Command = { name: string; args: string; help: string; run: (s: Session, args: string[]) => Promise<string | void> | string | void };

export const command = (name: string) => COMMANDS.find((c) => c.name === name);

export const COMMANDS: Command[] = [
  { name: "view", args: "", help: "print the view the agent sees", run: (s) => s.mem.render().join("") },
  {
    name: "zoom",
    args: "ID N",
    help: "open line ID+N (N = 1: the message whole)",
    run: (s, [id, n]) => s.mem.zoom(Number(id), Number(n ?? 1)),
  },
  {
    name: "log",
    args: "[FROM]",
    help: "print the raw log from message FROM on",
    run: (s, [from]) => chat(s.mem.root.slice(Number(from ?? 0)).map((m) => `${m.i}|${m.date}|${m.kind}: ${flat(m.text)}`)),
  },
  {
    name: "compact",
    args: "",
    help: "run the compactor until it has nothing to do",
    run: async (s) => void (await s.drain()),
  },
  { name: "stats", args: "", help: "counts of messages, nodes and view", run: (s) => s.stats() },
];

// One open chat, and a turn that Ctrl-C can stop.
export class Session {
  comp: Compactor;
  phase: "idle" | "settle" | "turn" | "drain" = "idle";
  private abort?: AbortController;

  constructor(public mem: Memory) {
    this.comp = new Compactor(mem);
  }

  stats() {
    const mem = this.mem;
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

  // Ctrl-C: stop the current phase. False if nothing is running.
  interrupt() {
    if (!this.abort) return false;
    this.abort.abort();
    return true;
  }

  private enter(phase: Session["phase"]) {
    this.phase = phase;
    this.abort = phase === "idle" ? undefined : new AbortController();
    return this.abort?.signal;
  }

  // Settle the view, answer, compact. Stopped while settling, the message stays
  // in the log, unanswered, and this returns false; stopped during the turn,
  // everything so far is already logged.
  async send(text: string) {
    let signal = this.enter("settle");
    if (!this.mem.settled()) console.error(dim("waiting for the compactor..."));
    if (!(await this.comp.settle(signal))) {
      this.mem.log("user", text);
      console.error("\ncancelled; message logged, unanswered");
      this.enter("idle");
      return false;
    }
    signal = this.enter("turn");
    try {
      await turn(this.mem, this.comp, text, signal);
    } catch (e) {
      if (!signal!.aborted) console.error("turn failed:", e instanceof Error ? e.message : e);
    }
    if (signal!.aborted) console.error();
    await this.drain();
    return true;
  }

  // Wait for the compactor to finish; stopped, it keeps going in the background.
  async drain() {
    const signal = this.enter("drain")!;
    await Promise.race([this.comp.drain(), new Promise((r) => signal.addEventListener("abort", r))]);
    this.enter("idle");
    console.error(signal.aborted ? "\nstopped waiting; the compactor keeps going" : dim(this.stats()));
  }
}
