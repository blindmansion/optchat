import { openai } from "@ai-sdk/openai";
import { generateText, type ModelMessage } from "ai";
import { COMPACT_EFFORT, COMPACT_MODEL, JOBS, NODE, RETRY, TRIES, bytes, cutBytes } from "./config";
import { flat, type Memory } from "./memory";
import { COMPACT_SYSTEM, WORDS } from "./prompts";

// Named in the step so the model tags the item right (it tagged poems by OptChat as "user").
const KINDS = {
  user: "the user's own words",
  talk: "OptChat's reply",
  tool: "OptChat's tool call",
  echo: "a tool result",
  note: "a memory from before this chat",
};

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

const dim = (s: string) => console.error(`\x1b[2m${s}\x1b[0m`);

// Builds tree nodes in the background, in the strict order of spec §4.1.
export class Compactor {
  busy = new Set<string>();
  failed = new Set<string>();
  private idlers: (() => void)[] = [];

  constructor(private mem: Memory) {}

  // First message whose view line is not built yet.
  first() {
    for (const p of this.mem.view) if (!this.mem.built(p.l, p.i)) return p.i * 2 ** p.l;
    return this.mem.T;
  }

  ready(l: number, i: number) {
    const m = this.mem;
    return l === 0 ? i < m.T : m.built(l - 1, 2 * i) && m.built(l - 1, 2 * i + 1);
  }

  // A source that already fits in NODE bytes is its own node, with no model call.
  free(l: number, i: number) {
    if (l === 0) {
      const m = this.mem.root[i]!;
      return m.size <= NODE ? `${m.kind}: ${m.text}` : undefined;
    }
    const s = `${this.mem.node(l - 1, 2 * i)}\n${this.mem.node(l - 1, 2 * i + 1)}`;
    return bytes(s) <= NODE ? s : undefined;
  }

  pump() {
    const m = this.mem;
    for (let progress = true; progress; ) {
      progress = false;
      let f = this.first();
      for (let l = 0; 2 ** l <= m.T; l++) {
        for (let i = 0; (i + 1) * 2 ** l <= m.T; i++) {
          if (this.busy.size >= JOBS) return;
          const k = `${l}:${i}`;
          const end = l === 0 ? i : (i + 1) * 2 ** l;
          if (m.built(l, i) || this.busy.has(k) || !this.ready(l, i) || end > f) continue;
          const text = this.free(l, i);
          if (text !== undefined) {
            m.save(l, i, text);
            f = this.first();
            progress = true;
            continue;
          }
          this.busy.add(k);
          this.build(l, i).then(
            () => {
              this.busy.delete(k);
              this.failed.delete(k);
              this.pump();
            },
            (err) => {
              if (!this.failed.has(k)) console.error(`compactor: node ${l}:${i} failed, retrying:`, err?.message ?? err);
              this.failed.add(k);
              setTimeout(() => {
                this.busy.delete(k);
                this.pump();
              }, RETRY);
            },
          );
        }
      }
    }
    if (this.busy.size === 0) for (const f of this.idlers.splice(0)) f();
  }

  async build(l: number, i: number) {
    const m = this.mem;
    const n = 2 ** l;
    const msg = m.root[i]!;
    // Deviation: sizes in words as well as bytes, since gpt-5.4-mini can't
    // count bytes and overshot merges by 50% even after every retry.
    const limit = `at most ${NODE} bytes (about ${WORDS} words)`;
    const size = (t: string) => `${bytes(t)} bytes, ${words(t)} words`;
    let step: string;
    if (l === 0) {
      const t = `${msg.kind}: ${msg.text}`;
      step = `Compress this ${msg.kind} message (${KINDS[msg.kind]}; ${size(t)}) into one line, ${limit}:\n${t}`;
    } else {
      const t = `${flat(m.node(l - 1, 2 * i)!)}\n${flat(m.node(l - 1, 2 * i + 1)!)}`;
      step = `Merge these two lines (${size(t)} together) into one line, ${limit}:\n${t}`;
    }
    const context = m.context(l === 0 ? i : (i + 1) * n);
    const tries: string[] = [];
    for (;;) {
      // Deviation from the spec: each retry is a fresh request with the last try
      // attached, not a follow-up turn. In a follow-up, gpt-5.4-mini summarized the
      // size feedback as if it were a chat message, or just returned the cut line.
      const last = tries.at(-1);
      const retry = last
        ? `\n\nYour last try was ${size(last)}: too long, cut about ${Math.max(5, words(last) - WORDS)} words. ` +
          `Here it is cut at the limit:\n${cutBytes(last, NODE)}| ← LIMIT\n` +
          `Write the whole line again so it fits: shrink the wording and the minor items, don't just cut the end.`
        : "";
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: context },
            { type: "text", text: `${step}${retry}` },
          ],
        },
      ];
      const r = await generateText({
        model: openai(COMPACT_MODEL),
        instructions: COMPACT_SYSTEM,
        messages,
        providerOptions: {
          openai: {
            store: false,
            reasoningEffort: COMPACT_EFFORT,
            reasoningSummary: null,
            promptCacheKey: "optchat-compact",
          },
        },
      });
      const line = r.text.trim();
      if (!line) throw new Error("empty reply");
      tries.push(line);
      if (bytes(line) <= NODE || tries.length >= TRIES) break;
    }
    const best = tries.reduce((a, b) => (bytes(b) < bytes(a) ? b : a));
    m.save(l, i, best);
    dim(`  ~ ${i * n}+${n} summarized: ${bytes(best)} B${tries.length > 1 ? `, ${tries.length} tries` : ""}`);
  }

  // Resolves true once every view part is a built summary, false if aborted.
  settle(signal?: AbortSignal) {
    return new Promise<boolean>((resolve) => {
      const check = () => {
        if (signal?.aborted) done(false);
        else if (this.mem.settled()) done(true);
      };
      const done = (ok: boolean) => {
        this.mem.listeners.delete(check);
        signal?.removeEventListener("abort", check);
        resolve(ok);
      };
      this.mem.listeners.add(check);
      signal?.addEventListener("abort", check);
      this.pump();
      check();
    });
  }

  // Resolves when nothing is running and nothing more can be started.
  drain() {
    return new Promise<void>((resolve) => {
      this.idlers.push(resolve);
      this.pump();
    });
  }
}
