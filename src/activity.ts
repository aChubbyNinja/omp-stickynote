import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type Attention = "idle" | "working" | "waiting" | "finished";
type Crew = "none" | "test" | "build" | "pass" | "fail";
type Milestone = "FIRST COMMIT" | "TESTS PASSED" | "RELEASED";
type Signal = "test" | "build" | "commit" | "npm" | "pnpm" | "yarn" | "cargo" | "gh";
interface Call { tool: string; signal?: Signal; order: number }
interface Callbacks {
  active(ctx: ExtensionContext): boolean;
  attention(value: Attention): void;
  crew(value: Crew): void;
  milestone(value: Milestone): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// This is deliberately not a shell parser: only literal words and an optional
// `cd <literal> &&` prefix are accepted. Never execute a shell to classify it.
function words(command: string): string[] | undefined {
  if (/[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(command)) return;
  const result: string[] = [];
  let word = "";
  let present = false;
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = "";
      else {
        if (quote === '"' && /[$`\\]/.test(c)) return;
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; present = true; continue; }
    if (c === " " || c === "\t") {
      if (present) { result.push(word); word = ""; present = false; }
      continue;
    }
    if (c === "&" && command[i + 1] === "&") {
      if (present) { result.push(word); word = ""; present = false; }
      result.push("&&");
      i++;
      continue;
    }
    if (/[;&|<>(){}#$`\\*?\[\]~]/.test(c)) return;
    word += c;
    present = true;
  }
  if (quote) return;
  if (present) result.push(word);
  if (result[0] === "cd" && result[2] === "&&" && result[1] && !result[1].startsWith("-")) result.splice(0, 3);
  if (result.includes("&&")) return;
  return result;
}

function signalFor(args: unknown): Signal | undefined {
  const input = record(args);
  if (!input || typeof input.command !== "string" || input.async === true || input.name != null || input.ready != null) return;
  const w = words(input.command);
  if (!w?.length) return;
  // These modes may exit successfully without executing tests/builds or publishing.
  if (w.some(arg => /^(?:--(?:help|version|dry-run|dryRun|list|listTests|list-tests|showConfig|show-config|clearCache|collect-only|collectonly|co|fixtures|fixtures-per-test|markers|setup-plan|build-plan|watch|watchAll|ui|interactive|draft|if-present|ignore-scripts|script-shell|plan|no-run|no-verify|passWithNoTests)(?:=|$)|-[hVn]$)/.test(arg))) return;
  const [exe, sub, third] = w;
  if (exe === "git" && sub === "commit") {
    if (w.some(arg => /^(?:--(?:short|long|porcelain|branch|null)(?:=|$)|-z$)/.test(arg))) return;
    return "commit";
  }
  if (exe === "gh" && sub === "release" && third === "create") {
    if (w.some(arg => /^-[^-]*d/.test(arg))) return;
    return "gh";
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(exe)) {
    const action = sub === "run" || sub === "run-script" ? third : sub;
    if (action === "test" || (exe === "npm" && sub === "t")) return "test";
    if (action === "build") return "build";
    if (sub === "publish" && (exe === "npm" || exe === "pnpm" || exe === "yarn")) return exe;
    if (exe === "yarn" && sub === "npm" && third === "publish") return "yarn";
  }
  if (exe === "cargo" && sub === "test") return "test";
  if (exe === "cargo" && sub === "build") return "build";
  if (exe === "cargo" && sub === "publish") return "cargo";
  if (exe === "node" && sub === "--test") return "test";
  if (exe === "pytest" || exe === "pytest-3") return "test";
  if (["python", "python3"].includes(exe) && sub === "-m" && third === "pytest") return "test";
  if (exe === "vitest" && sub === "run") return "test";
  if (exe === "jest") return "test";
  if (exe === "npx" && ((sub === "vitest" && third === "run") || sub === "jest")) return "test";
  if (exe === "go" && (sub === "test" || sub === "build")) {
    if (w.some(arg => /^(?:-list(?:=|$)|-c$)/.test(arg))) return;
    return sub === "test" ? "test" : "build";
  }
}

// A zero exit can mean dry-run, draft or staged publication. Require the
// corresponding CLI's final publication evidence in this matched call's output.
function released(signal: Signal, result: unknown): boolean {
  if (signal === "test" || signal === "build" || signal === "commit") return false;
  const content = record(result)?.content;
  if (!Array.isArray(content)) return false;
  const text = content.flatMap(block => {
    const value = record(block);
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  if (/\b(?:dry[- ]run|draft|staged|staging|being processed|pending|awaiting|processing|not published)\b/i.test(text)) return false;
  if (signal === "npm" || signal === "pnpm") {
    if ([process.env.npm_config_dry_run, process.env.NPM_CONFIG_DRY_RUN].some(value => value != null && !/^(?:false|0)$/i.test(value))) return false;
    return /^npm notice Publishing to https?:\/\/\S+ with tag \S+ and (?:public|restricted|default) access\.?\s*$/m.test(text) &&
      /^\+ (?:@[^/\s]+\/)?[^@\s]+@\S+\s*$/m.test(text);
  }
  if (signal === "yarn") return /^(?:success Published\.|➤ YN0000: Package successfully published)\s*$/m.test(text);
  if (signal === "cargo") return /^\s*Published \S+ v\S+ at registry .+\s*$/m.test(text);
  if (signal === "gh") return /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/releases\/tag\/(?!untagged-)\S+\s*$/m.test(text);
  return false;
}

/** Observe live main-session events only; reset silently invalidates all in-flight calls. */
export function registerActivity(pi: ExtensionAPI, callbacks: Callbacks): { reset(): void } {
  const calls = new Map<string, Call>();
  const approvals = new Set<string>();
  let generation = 0;
  let order = 0;
  let running = false;
  let failed = false;
  let crewFailed = false;
  let committed = false;
  let lastAttention: Attention | undefined;
  let lastCrew: Crew | undefined;

  function reset(): void {
    generation++;
    calls.clear();
    approvals.clear();
    running = failed = crewFailed = committed = false;
    lastAttention = lastCrew = undefined;
  }
  function guard(ctx: ExtensionContext): boolean {
    if (ctx.agent.kind !== "main") return false;
    if (!callbacks.active(ctx)) { reset(); return false; }
    return true;
  }
  function emit(ctx: ExtensionContext, token: number, fn: () => void): void {
    if (token === generation && guard(ctx)) fn();
  }
  function attention(ctx: ExtensionContext, token: number, value: Attention): void {
    emit(ctx, token, () => {
      if (lastAttention === value) return;
      lastAttention = value;
      callbacks.attention(value);
    });
  }
  function crew(ctx: ExtensionContext, token: number, value: Crew): void {
    emit(ctx, token, () => {
      if (lastCrew === value) return;
      lastCrew = value;
      callbacks.crew(value);
    });
  }
  function waiting(): boolean {
    if (approvals.size > 0) return true;
    for (const call of calls.values()) if (call.tool === "ask") return true;
    return false;
  }
  function currentCrew(): "test" | "build" | undefined {
    let latest: Call | undefined;
    for (const call of calls.values()) {
      if ((call.signal === "test" || call.signal === "build") && (!latest || call.order > latest.order)) latest = call;
    }
    return latest?.signal as "test" | "build" | undefined;
  }
  function busy(ctx: ExtensionContext, token: number): void {
    attention(ctx, token, waiting() ? "waiting" : "working");
  }
  function pending(ctx: ExtensionContext): boolean {
    const snapshot = ctx.getAsyncJobSnapshot();
    return !!snapshot && (snapshot.running.length > 0 || snapshot.delivery.queued > 0 || snapshot.delivery.delivering || snapshot.delivery.pendingJobIds.length > 0);
  }
  function finish(ctx: ExtensionContext, id: string, tool: string, result: unknown, isError: boolean): void {
    if (!guard(ctx)) return;
    const call = calls.get(id);
    if (!call || call.tool !== tool) return;
    const token = generation;
    calls.delete(id);
    approvals.delete(id);
    const details = record(record(result)?.details);
    const deferred = record(details?.async);
    const unfinished = !!deferred && deferred.state !== "completed";
    const error = isError || details?.timedOut === true || details?.cancelled === true ||
      (typeof details?.exitCode === "number" && details.exitCode !== 0) ||
      deferred?.state === "failed" || deferred?.state === "cancelled";
    if (error) failed = true;
    // The installed bash tool omits exitCode on a successful synchronous exit.
    // A running job/service is not a successful exit, even with isError=false.
    const success = !error && !unfinished && !details?.service && !!details;
    if (call.signal === "test" || call.signal === "build") {
      if (error) crewFailed = true;
      const live = currentCrew();
      crew(ctx, token, live ?? (unfinished ? "none" : crewFailed ? "fail" : success ? "pass" : "none"));
      if (!live) crewFailed = false;
    }
    if (token !== generation || !guard(ctx)) return;
    if (success && call.signal) {
      if (call.signal === "commit" && !committed) {
        committed = true;
        emit(ctx, token, () => callbacks.milestone("FIRST COMMIT"));
      } else if (call.signal === "test") emit(ctx, token, () => callbacks.milestone("TESTS PASSED"));
      else if (released(call.signal, result)) emit(ctx, token, () => callbacks.milestone("RELEASED"));
    }
    if (running) busy(ctx, token);
    else attention(ctx, token, waiting() ? "waiting" : "idle");
  }

  pi.on("input", (event, ctx) => {
    if (!guard(ctx) || event.source === "extension" || !event.text.trim() || event.text.trimStart().startsWith("/")) return;
    busy(ctx, generation);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (!guard(ctx)) return;
    if (!running) failed = false;
    running = true;
    busy(ctx, generation);
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!guard(ctx)) return;
    if (!running) failed = false;
    running = true;
    busy(ctx, generation);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (!guard(ctx)) return;
    const token = generation;
    const signal = event.toolName === "bash" ? signalFor(event.args) : undefined;
    calls.set(event.toolCallId, { tool: event.toolName, signal, order: ++order });
    if (signal === "test" || signal === "build") crew(ctx, token, signal);
    busy(ctx, token);
  });
  pi.on("tool_execution_end", (event, ctx) => finish(ctx, event.toolCallId, event.toolName, event.result, event.isError));
  // tool_result precedes tool_execution_end in some hosts; consuming the tracked
  // call once makes the two notifications idempotent and rejects stale results.
  pi.on("tool_result", (event, ctx) => finish(ctx, event.toolCallId, event.toolName, { details: event.details, content: event.content }, event.isError));
  pi.on("tool_approval_requested", (event, ctx) => {
    if (!guard(ctx)) return;
    approvals.add(event.toolCallId);
    attention(ctx, generation, "waiting");
  });
  pi.on("tool_approval_resolved", (event, ctx) => {
    if (!guard(ctx)) return;
    approvals.delete(event.toolCallId);
    if (!event.approved) failed = true;
    busy(ctx, generation);
  });
  pi.on("message_end", (event, ctx) => {
    if (!guard(ctx)) return;
    if (event.message.role === "assistant" && (event.message.stopReason === "error" || event.message.stopReason === "aborted")) failed = true;
  });
  pi.on("agent_end", (event, ctx) => {
    if (!guard(ctx)) return;
    const token = generation;
    if (event.messages.some(message => message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"))) failed = true;
    const terminal = event.messages.at(-1);
    if (!event.willContinue && !event.awaitingAsyncWork && terminal?.role === "assistant" && (terminal.stopReason === "error" || terminal.stopReason === "aborted")) {
      calls.clear();
      approvals.clear();
      running = false;
      crewFailed = false;
      const cancelled = ++generation;
      crew(ctx, cancelled, "none");
      attention(ctx, cancelled, "idle");
      return;
    }
    if (waiting()) { attention(ctx, token, "waiting"); return; }
    if (event.willContinue || event.awaitingAsyncWork || calls.size > 0 || pending(ctx)) { attention(ctx, token, "working"); return; }
    running = false;
    const last = event.messages.at(-1);
    attention(ctx, token, !failed && last?.role === "assistant" && last.stopReason === "stop" ? "finished" : "idle");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent.kind === "main") reset();
  });
  return { reset };
}
