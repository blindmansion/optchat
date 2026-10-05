import { resolve } from "node:path";

const env = process.env;

export const NODE = 512; // target bytes of one summary line
export const VIEW = Number(env.OPTCHAT_VIEW ?? 128_000); // byte budget of the view
export const JOBS = 8; // compactor calls running at once
export const TRIES = 5; // attempts per node to get under NODE
export const RETRY = 10_000; // ms before retrying a failed node
export const CAP = 30_000; // max chars of one tool result
export const MARKS = [50_000, 80_000, 100_000]; // cache breakpoints inside the view (chars)

export const DIR = resolve(env.OPTCHAT_DIR ?? "chat");
export const MODEL = env.OPTCHAT_MODEL ?? "gpt-5.4-mini";
export const EFFORT = env.OPTCHAT_EFFORT ?? "medium";
export const COMPACT_MODEL = env.OPTCHAT_COMPACT_MODEL ?? "gpt-5.4-mini";
export const COMPACT_EFFORT = env.OPTCHAT_COMPACT_EFFORT ?? "medium";
// Explicit prompt_cache_breakpoint marks need GPT-5.6+; older models cache implicitly.
export const BREAKPOINTS = env.OPTCHAT_BREAKPOINTS === "1";

export const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// Cut a string to at most n UTF-8 bytes without splitting a character.
export function cutBytes(s: string, n: number) {
  return Buffer.from(s, "utf8").subarray(0, n).toString("utf8").replace(/�$/, "");
}

// Keep the head and tail of a long tool result, with a note of what was cut.
export function cap(s: string) {
  if (s.length <= CAP) return s;
  const half = Math.floor(CAP / 2);
  return `${s.slice(0, half)}\n[... ${s.length - 2 * half} characters cut ...]\n${s.slice(-half)}`;
}
