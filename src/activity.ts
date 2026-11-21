import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type Attention = "idle" | "working" | "waiting" | "finished";
type WorkingCrew = "test" | "build" | "editing";
type Crew = "none" | WorkingCrew | "pass" | "fail";
type Milestone = "FIRST COMMIT" | "TESTS PASSED" | "RELEASED";
type Signal = "test" | "build" | "commit" | "npm" | "pnpm" | "yarn" | "cargo" | "gh";
interface Activity { signals: Signal[]; crew?: WorkingCrew; device?: string; observedOnly?: boolean }
interface Call extends Activity { tool: string; order: number }
interface Callbacks {
  active(ctx: ExtensionContext): boolean;
  attention(value: Attention): void;
  crew(value: Crew): void;
  milestone(value: Milestone): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// Recognize literal && chains only: their zero exit proves every segment ran
// successfully. Separators inside quotes remain data, never shell syntax.
function words(command: string): string[][] | undefined {
  if (/[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(command)) return;
  const result: string[][] = [];
  let segment: string[] = [];
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
      if (present) { segment.push(word); word = ""; present = false; }
      continue;
    }
    if (c === "&" && command[i + 1] === "&") {
      if (present) { segment.push(word); word = ""; present = false; }
      if (!segment.length) return;
      result.push(segment);
      segment = [];
      i++;
      continue;
    }
    if (/[;&|<>(){}#$`\\*?\[\]~]/.test(c)) return;
    word += c;
    present = true;
  }
  if (quote) return;
  if (present) segment.push(word);
  if (!segment.length) return;
  result.push(segment);
  return result;
}

function signalFor(w: string[]): Signal | undefined {
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

function shellActivity(args: unknown): Activity {
  const input = record(args);
  if (!input || typeof input.command !== "string" || input.async === true || input.name != null || input.ready != null) return { signals: [] };
  const segments = words(input.command);
  if (!segments) return { signals: [] };
  const signals: Signal[] = [];
  for (const w of segments) {
    if (segments.length > 1 && w[0] === "cd" && w.length === 2 && w[1] && !w[1].startsWith("-")) continue;
    const signal = signalFor(w);
    if (signal) signals.push(signal);
    // Common validation steps can precede/follow tests, but don't themselves
    // establish a test/build milestone. Never accept arbitrary shell builtins
    // (e.g. `exit 0 && npm test`) or unrecognized scripts as proof.
    else if (!(segments.length > 1 && ["npm", "pnpm", "yarn", "bun"].includes(w[0]) &&
      w[1] === "run" && w.length === 3 && ["check", "lint", "typecheck"].includes(w[2]))) return { signals: [] };
  }
  // Publication/commit output cannot be attributed to one segment in a chain.
  // Preserve the established single-command `cd dir && git commit` form.
  if (signals.some(signal => signal !== "test" && signal !== "build") &&
    segments.filter(w => w[0] !== "cd").length !== 1) return { signals: [] };
  const last = signals.at(-1);
  const crew = last === "test" || last === "build" ? last : undefined;
  return { signals, crew };
}

function filesystemPath(path: unknown): path is string {
  return typeof path === "string" && !!path &&
    (!/^[a-z][a-z\d+.-]*:\/\//i.test(path) || /^(?:local|file|ssh):\/\//.test(path));
}

function editsFiles(args: unknown): boolean {
  const input = record(args);
  if (input?.path !== undefined) return filesystemPath(input.path);
  const patch = typeof args === "string" ? args : input?.input;
  if (typeof patch !== "string") return false;
  const paths = Array.from(patch.matchAll(/^(?:\[([^\r\n#]+)#[0-9a-fA-F]{4}\]|\*\*\* (?:Update|Add|Delete) File: ([^\r\n]+))$/gm),
    match => match[1] ?? match[2]);
  return paths.length > 0 && paths.every(filesystemPath);
}

function activityFor(tool: string, args: unknown): Activity {
  if (tool === "bash" || tool === "functions.bash") return shellActivity(args);
  if (tool === "edit" || tool === "functions.edit") return { signals: [], crew: editsFiles(args) ? "editing" : undefined };
  const input = record(args);
  if (tool === "write" || tool === "functions.write") {
    if (typeof input?.path !== "string") return { signals: [] };
    const device = /^xd:\/\/(bash|edit)$/.exec(input.path)?.[1];
    if (device && typeof input.content === "string") {
      try {
        const inner = JSON.parse(input.content);
        if (!record(inner)) return { signals: [] };
        return { ...activityFor(device, inner), device };
      } catch { return { signals: [] }; }
    }
    // Control-plane writes are messages, replies or tool dispatch, not coding.
    if (filesystemPath(input.path)) {
      return { signals: [], crew: "editing" };
    }
  }
  if (tool === "multi_tool_use.parallel" && Array.isArray(input?.tool_uses)) {
    // This provider wrapper has no standardized per-child result contract.
    // Observe attempted work, but never turn its aggregate success into stamps.
    let crew: WorkingCrew | undefined;
    for (const entry of input.tool_uses) {
      const child = record(entry);
      if (typeof child?.recipient_name === "string" && child.recipient_name !== tool) {
        crew = activityFor(child.recipient_name, child.parameters).crew ?? crew;
      }
    }
    return { signals: [], crew, observedOnly: true };
  }
  return { signals: [] };
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

// Deliberately lexical: only a direct question at the end of a settled reply
// counts. Examples, quoted questions and code are not requests for an answer.
function endsWithQuestion(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  const text = content.flatMap(block => {
    const value = record(block);
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("\n");
  const lines: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = { marker: marker[1]![0]!, length: marker[1]!.length }; continue; }
    if (/^(?: {0,3}>| {4}|\t)/.test(line)) continue;
    lines.push(line);
  }
  const prose = lines.join("\n")
    .replace(/(`+)[\s\S]*?\1/g, "")
    .replace(/"[^"\n]*"|“[^”]*”|‘[^’]*’|(?:^|\s)'[^'\n]*'(?=\s|[.!?]|$)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]+/g, "")
    .trim();
  if (!prose.endsWith("?")) return false;
  const question = prose.slice(0, -1).split(/[.!?]\s+|\n+|:\s+/).at(-1)!.trim().replace(/^(?:[-+•]|\d+[.)])\s+/, "");
  return /^(?:can|could|would|will|do|did|are|were|have|has)\s+you\b/i.test(question) ||
    /^(?:should|shall|may|can|could|would|do|did|are|will)\s+(?:i|we)\b/i.test(question) ||
    /^(?:what|which|where|when|how|who)\b[^?]*\b(?:you|your|i|we|our|should)\b/i.test(question) ||
    /^(?:what|which|where|when|how|who|whose)\s+(?!(?:could|would)\b)\S/i.test(question) ||
    /^\S+(?:\s+\S+){0,3}\s+or\s+\S+(?:\s+\S+){0,3}$/i.test(question) ||
    /^(?:is|does)\s+(?:this|that)\s+(?:work|okay|ok|acceptable|sound)\b/i.test(question);
}

/** Observe live main-session events only; reset silently invalidates all in-flight calls. */
export function registerActivity(pi: ExtensionAPI, callbacks: Callbacks): { reset(): void } {
  const calls = new Map<string, Call>();
  const registeredCalls = new Map<string, string>();
  const unmirroredResults = new Set<string>();
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
    registeredCalls.clear();
    unmirroredResults.clear();
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
  function currentCrew(): WorkingCrew | undefined {
    let latest: Call | undefined;
    for (const call of calls.values()) {
      if (call.crew && (!latest || call.order > latest.order)) latest = call;
    }
    return latest?.crew;
  }
  function busy(ctx: ExtensionContext, token: number): void {
    attention(ctx, token, waiting() ? "waiting" : "working");
  }
  function pending(ctx: ExtensionContext): boolean {
    const snapshot = ctx.getAsyncJobSnapshot();
    return !ctx.isIdle() || ctx.hasPendingMessages() ||
      (!!snapshot && (snapshot.running.length > 0 || snapshot.delivery.queued > 0 || snapshot.delivery.delivering || snapshot.delivery.pendingJobIds.length > 0));
  }
  function finish(ctx: ExtensionContext, id: string, tool: string, result: unknown, isError: boolean): void {
    if (!guard(ctx)) return;
    const call = calls.get(id);
    if (!call || call.tool !== tool) return;
    const token = generation;
    calls.delete(id);
    registeredCalls.delete(id);
    approvals.delete(id);
    const outerDetails = record(record(result)?.details);
    const dispatch = record(outerDetails?.xdev);
    const matchedDevice = !call.device || (dispatch?.tool === call.device && dispatch.mode === "execute");
    const details = call.device ? (matchedDevice ? record(dispatch?.inner) : undefined) : outerDetails;
    const deferred = record(details?.async);
    const unfinished = !!deferred && deferred.state !== "completed";
    const error = isError || record(result)?.isError === true || details?.timedOut === true || details?.cancelled === true ||
      (typeof details?.exitCode === "number" && details.exitCode !== 0) ||
      deferred?.state === "failed" || deferred?.state === "cancelled";
    if (error) failed = true;
    // The installed bash tool omits exitCode on a successful synchronous exit.
    // A running job/service is not a successful exit, even with isError=false.
    const success = !call.observedOnly && matchedDevice && !error && !unfinished && !details?.service && !!details;
    if (call.crew) {
      if (error && call.crew !== "editing") crewFailed = true;
      const live = currentCrew();
      crew(ctx, token, live ?? (unfinished ? "none" : crewFailed ? "fail" : call.crew === "editing" || call.observedOnly ? "none" : success ? "pass" : "none"));
      if (!live) crewFailed = false;
    }
    if (token !== generation || !guard(ctx)) return;
    if (success) for (const signal of new Set(call.signals)) {
      if (signal === "commit" && !committed) {
        committed = true;
        emit(ctx, token, () => callbacks.milestone("FIRST COMMIT"));
      } else if (signal === "test") emit(ctx, token, () => callbacks.milestone("TESTS PASSED"));
      else if (released(signal, result)) emit(ctx, token, () => callbacks.milestone("RELEASED"));
    }
    if (running || pending(ctx)) busy(ctx, token);
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
  // Eval's public tool bridge executes registered wrappers directly: it emits
  // tool_call/tool_result, but no tool_execution_* lifecycle. A preflight can
  // still be denied, so remember it without claiming execution or pending work.
  pi.on("tool_call", (event, ctx) => {
    if (!guard(ctx) || unmirroredResults.has(event.toolCallId)) return;
    // Denied preflights need not produce a result. Bound their retention and
    // clear them on terminal settle/reset; eviction only loses a possible cue.
    if (registeredCalls.size >= 512) registeredCalls.delete(registeredCalls.keys().next().value!);
    registeredCalls.set(event.toolCallId, event.toolName);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (!guard(ctx) || unmirroredResults.has(event.toolCallId)) return;
    const token = generation;
    const activity = activityFor(event.toolName, event.args);
    registeredCalls.delete(event.toolCallId);
    calls.set(event.toolCallId, { tool: event.toolName, ...activity, order: ++order });
    if (activity.crew) crew(ctx, token, activity.crew);
    busy(ctx, token);
  });
  pi.on("tool_execution_end", (event, ctx) => finish(ctx, event.toolCallId, event.toolName, event.result, event.isError));
  // Match either delivery path once. The result's input is the executed input,
  // including revisions made by other extensions after the preflight event.
  pi.on("tool_result", (event, ctx) => {
    if (!guard(ctx)) return;
    if (!calls.has(event.toolCallId) && registeredCalls.get(event.toolCallId) === event.toolName) {
      const token = generation;
      // Registered results can race the lifecycle mirror. Retain a bounded
      // completion marker so a delayed start/end cannot replay the same cue.
      if (unmirroredResults.size >= 512) unmirroredResults.delete(unmirroredResults.values().next().value!);
      unmirroredResults.add(event.toolCallId);
      const activity = activityFor(event.toolName, event.input);
      calls.set(event.toolCallId, { tool: event.toolName, ...activity, order: ++order });
      if (activity.crew) crew(ctx, token, activity.crew);
    }
    finish(ctx, event.toolCallId, event.toolName, { details: event.details, content: event.content }, event.isError);
  });
  pi.on("tool_approval_requested", (event, ctx) => {
    if (!guard(ctx)) return;
    approvals.add(event.toolCallId);
    attention(ctx, generation, "waiting");
  });
  pi.on("tool_approval_resolved", (event, ctx) => {
    if (!guard(ctx) || !approvals.delete(event.toolCallId)) return;
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
    if (!event.willContinue && !event.awaitingAsyncWork && ctx.isIdle() && !ctx.hasPendingMessages() &&
      terminal?.role === "assistant" && (terminal.stopReason === "error" || terminal.stopReason === "aborted")) {
      calls.clear();
      registeredCalls.clear();
      approvals.clear();
      running = false;
      crewFailed = false;
      const cancelled = ++generation;
      crew(ctx, cancelled, "none");
      attention(ctx, cancelled, "idle");
      return;
    }
    if (event.willContinue || event.awaitingAsyncWork || pending(ctx)) {
      attention(ctx, token, waiting() ? "waiting" : "working");
      return;
    }
    // An idle terminal host settle is authoritative, including when an eval
    // wrapper or cancellation omitted a mirrored tool/approval end event.
    running = false;
    const hadCrew = currentCrew() !== undefined;
    calls.clear();
    registeredCalls.clear();
    approvals.clear();
    crewFailed = false;
    if (hadCrew) crew(ctx, token, "none");
    const last = event.messages.at(-1);
    const finalReply = last?.role === "assistant" && last.stopReason === "stop" &&
      !last.content?.some(block => block.type === "toolCall");
    attention(ctx, token, finalReply && endsWithQuestion(last.content) ? "waiting" : finalReply && !failed ? "finished" : "idle");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent.kind === "main") reset();
  });
  return { reset };
}
