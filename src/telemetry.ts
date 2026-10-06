import { OpenTelemetry } from "@ai-sdk/otel";
import { context, register, setSession, trace, traceAgent } from "@arizeai/phoenix-otel";
import { registerTelemetry } from "ai";
import { DIR } from "./config";

// Traces every AI SDK call to Phoenix. Server and project come from
// PHOENIX_COLLECTOR_ENDPOINT (default http://localhost:6006) and PHOENIX_PROJECT.
const provider = register({ projectName: process.env.PHOENIX_PROJECT ?? "optchat" });

registerTelemetry(
  new OpenTelemetry({
    tracer: provider.getTracer("@arizeai/phoenix-otel/ai-sdk"),
    headers: false, // can hold the API key
  }),
);

// The chat's turns are one session; the compactor's jobs are another, so they
// don't crowd the conversation in Phoenix's Sessions tab.
export const SESSIONS = { optchat: DIR, compactor: `${DIR} (compactor)` };

type Io<A extends unknown[], R> = {
  input: (args: A) => string;
  output: (r: R) => string;
  metadata?: (args: A) => Record<string, unknown>;
};

// Each call of fn becomes the root of its own trace: an AGENT span called name,
// in that agent's session, with a readable input and output. The AI SDK spans
// of the model calls inside nest under it. A new trace even if a span is active,
// so a compactor job started during a turn is not filed under that turn.
export function agent<A extends unknown[], R>(name: keyof typeof SESSIONS, fn: (...args: A) => Promise<R>, io: Io<A, R>) {
  const traced = traceAgent(fn, {
    name,
    attributes: { "agent.name": name },
    processInput: (...args: A) => ({
      "input.value": io.input(args),
      "input.mime_type": "text/plain",
      ...(io.metadata && { metadata: JSON.stringify(io.metadata(args)) }),
    }),
    processOutput: (r: R) => ({ "output.value": io.output(r), "output.mime_type": "text/plain" }),
  });
  return (...args: A) => {
    const root = setSession(trace.deleteSpan(context.active()), { sessionId: SESSIONS[name] });
    return context.with(root, () => traced(...args));
  };
}

// Send what is buffered before the process exits; don't hang if Phoenix is down.
export const flush = () => Promise.race([provider.forceFlush().catch(() => {}), Bun.sleep(3000)]);
