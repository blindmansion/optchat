import { createInterface } from "node:readline";
import { COMMANDS, type Session, command } from "./session";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const HELP = [
  ...COMMANDS.map((c) => `  ${`/${c.name} ${c.args}`.padEnd(16)}${c.help}`),
  `  ${"/help".padEnd(16)}this list`,
  `  ${"/exit".padEnd(16)}quit (or Ctrl-D)`,
  "anything else is a message; lines pasted together are one message.",
  "Ctrl-C stops what is running: the wait for the view, the turn, then the compactor.",
].join("\n");

// The one-shot loop, many times over in one process. At the prompt readline has
// the terminal in raw mode; while working it is paused in cooked mode, so Ctrl-C
// is a real SIGINT that reaches the session straight away.
export function repl(s: Session, exit: (code: number) => never) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> ", historySize: 1000 });
  let busy = false;
  let closing = false;
  let lines: string[] = [];

  const work = (on: boolean) => {
    busy = on;
    if (on) rl.pause(), process.stdin.setRawMode(false);
    else process.stdin.setRawMode(true), rl.resume();
  };

  process.on("SIGINT", () => {
    if (closing) console.error("\ncompactor stopped; it resumes next run"), exit(130);
    s.interrupt();
  });

  // At the prompt: Ctrl-C clears the line, or quits on an empty one.
  rl.on("SIGINT", () => {
    if (!rl.line) return rl.close();
    rl.write(null, { ctrl: true, name: "e" });
    rl.write(null, { ctrl: true, name: "u" });
  });

  async function run(text: string) {
    if (text.includes("\n") || !text.startsWith("/")) return void (await s.send(text));
    const [name = "", ...args] = text.slice(1).split(/\s+/);
    if (name === "help") return console.log(HELP);
    const c = command(name);
    if (!c) return console.error(`unknown command /${name}; /help lists them`);
    const out = await c.run(s, args);
    if (out !== undefined) console.log(out);
  }

  async function flush() {
    const text = lines.join("\n").trim();
    lines = [];
    if (text === "/exit" || text === "/quit") return rl.close();
    if (text) {
      work(true);
      await run(text).catch((e) => console.error(e instanceof Error ? e.message : e));
      work(false);
    }
    if (lines.length) setTimeout(flush, 10); // typed ahead while working
    else rl.prompt();
  }

  // Wait a moment after a line, so a pasted block arrives as one message.
  rl.on("line", (line) => {
    lines.push(line);
    if (lines.length === 1 && !busy) setTimeout(flush, 10);
  });

  console.error(dim(`${s.stats()}\n/help for commands, Ctrl-D to quit`));
  rl.prompt();
  return new Promise<number>((resolve) => {
    rl.on("close", async () => {
      closing = true;
      console.error();
      if (s.comp.busy.size) await s.drain(); // Ctrl-C here quits at once
      resolve(0);
    });
  });
}
