import { flush } from "./telemetry"; // first, so tracing is on before anything else loads
import { DIR } from "./config";
import { lock, open } from "./db";
import { Memory } from "./memory";
import { repl } from "./repl";
import { COMMANDS, Session, command } from "./session";

const USAGE = `usage:
  bun chat                interactive session (in a terminal); /help lists its commands
  bun chat "message"      one turn: settle the view, answer, compact, exit
  bun chat -              read the message from stdin
${COMMANDS.map((c) => `  ${`bun chat --${c.name} ${c.args}`.padEnd(24)}${c.help}`).join("\n")}

env: OPTCHAT_DIR, OPTCHAT_VIEW (bytes), OPTCHAT_MODEL, OPTCHAT_EFFORT,
     OPTCHAT_COMPACT_MODEL, OPTCHAT_COMPACT_EFFORT, OPTCHAT_BREAKPOINTS=1,
     PHOENIX_COLLECTOR_ENDPOINT (default http://localhost:6006), PHOENIX_PROJECT (default optchat)`;

const args = process.argv.slice(2);
// Without a terminal (an agent, a pipe), no arguments stays a usage error.
const interactive = args.length === 0 && process.stdin.isTTY && process.stdout.isTTY;
if (!interactive && (args.length === 0 || args[0] === "--help" || args[0] === "-h")) {
  console.log(USAGE);
  process.exit(args.length === 0 ? 1 : 0);
}

const unlock = await lock(DIR).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
const exit = async (code = 0): Promise<never> => {
  unlock();
  await flush();
  process.exit(code);
};

const session = new Session(new Memory(open(DIR)));
if (interactive) await exit(await repl(session, exit));

// Ctrl-C: while waiting for the view, keep the message in the log, unanswered;
// during the turn, stop it (everything so far is already logged).
process.on("SIGINT", () => {
  if (session.phase === "drain") console.error("\ncompactor stopped; it resumes next run");
  if (session.phase === "drain" || !session.interrupt()) exit(130);
});

const cmd = args[0]!;
const c = cmd.startsWith("--") ? command(cmd.slice(2)) : undefined;
if (c) {
  const out = await c.run(session, args.slice(1));
  if (out !== undefined) console.log(out);
  await exit();
}

const text = (cmd === "-" ? await Bun.stdin.text() : args.join(" ")).trim();
if (!text) await exit(1);
await exit((await session.send(text)) ? 0 : 130);
