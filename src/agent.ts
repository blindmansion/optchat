import { openai } from "@ai-sdk/openai";
import { stepCountIs, streamText, tool } from "ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BREAKPOINTS, DIR, EFFORT, MODEL, cap } from "./config";
import type { Compactor } from "./compactor";
import type { Memory } from "./memory";
import { MASTER, VIEW_DOC } from "./prompts";
import { agent } from "./telemetry";

const out = (s: string) => process.stdout.write(s);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// MASTER + VIEW_DOC + the user's own instructions. Byte-identical across calls.
function system() {
  const file = join(DIR, "AGENTS.md");
  const agents = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  return [MASTER, VIEW_DOC, agents].filter(Boolean).join("\n\n");
}

function tools(mem: Memory) {
  return {
    zoom: tool({
      description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
      inputSchema: z.object({ id: z.number().int(), n: z.number().int() }),
      execute: async ({ id, n }) => cap(mem.zoom(id, n)),
    }),
    date: tool({
      description: "The date and time of message id.",
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => mem.date(id),
    }),
  };
}

// One fresh model call: [system] [view] [new message], logging everything it does.
// Returns the reply, for the trace.
async function run(mem: Memory, comp: Compactor, text: string, signal?: AbortSignal) {
  const view = mem.render(); // before the new message is logged
  mem.log("user", text);
  comp.pump();

  const mark = BREAKPOINTS ? { openai: { promptCacheBreakpoint: { mode: "explicit" } } } : undefined;
  const result = streamText({
    model: openai(MODEL),
    instructions: system(),
    messages: [
      {
        role: "user",
        content: [...view.map((piece) => ({ type: "text" as const, text: piece, providerOptions: mark })), { type: "text", text }],
      },
    ],
    tools: tools(mem),
    stopWhen: stepCountIs(100),
    abortSignal: signal,
    providerOptions: {
      openai: {
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoningEffort: EFFORT,
        reasoningSummary: "auto",
        reasoningContext: "all_turns",
        promptCacheKey: "optchat",
      },
    },
    telemetry: { functionId: "optchat" },
  });

  const texts = new Map<string, string>();
  const reply: string[] = [];
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "reasoning-start": // shown, never logged
        out("\x1b[2m");
        break;
      case "reasoning-delta":
        out(part.text);
        break;
      case "reasoning-end":
        out("\x1b[0m\n");
        break;
      case "text-delta":
        out(part.text);
        texts.set(part.id, (texts.get(part.id) ?? "") + part.text);
        break;
      case "text-end": {
        out("\n");
        const t = texts.get(part.id)?.trim();
        if (t) mem.log("talk", t), comp.pump(), reply.push(t);
        break;
      }
      case "tool-call": {
        const t = `${part.toolName} ${JSON.stringify(part.input)}`;
        out(dim(`→ ${t}\n`));
        mem.log("tool", t);
        break;
      }
      case "tool-result": {
        const o = typeof part.output === "string" ? part.output : JSON.stringify(part.output);
        out(dim(`← ${o.length > 300 ? `${o.slice(0, 300)}…` : o}\n`));
        mem.log("echo", cap(o));
        comp.pump();
        break;
      }
      case "tool-error": {
        const o = `Error: ${part.error instanceof Error ? part.error.message : String(part.error)}`;
        out(dim(`← ${o}\n`));
        mem.log("echo", cap(o));
        break;
      }
      case "finish-step": {
        const u = part.usage;
        console.error(
          dim(`  [${MODEL}] in ${u.inputTokens} (cached ${u.inputTokenDetails.cacheReadTokens ?? 0}) out ${u.outputTokens}`),
        );
        break;
      }
      case "error":
        throw part.error;
    }
  }
  return reply.join("\n\n");
}

// In Phoenix: one "optchat" trace per turn, input the user's message, output the reply.
export const turn = agent("optchat", run, {
  input: ([, , text]) => text,
  output: (reply) => reply,
  metadata: ([mem]) => ({ message: mem.T }), // id the user's message gets in the log
});
