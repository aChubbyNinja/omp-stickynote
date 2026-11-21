import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { registerActivity } from "../src/activity.ts";

function harness() {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const attention: string[] = [];
  const crew: string[] = [];
  const milestones: string[] = [];
  let enabled = true;
  let snapshot: unknown = null;
  const ctx = {
    agent: { kind: "main" },
    getAsyncJobSnapshot: () => snapshot,
  } as unknown as ExtensionContext;
  let onCrew: ((value: string) => void) | undefined;
  const api = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
  } as unknown as ExtensionAPI;
  const observer = registerActivity(api, {
    active: () => enabled,
    attention(value) { attention.push(value); },
    crew(value) { crew.push(value); onCrew?.(value); },
    milestone(value) { milestones.push(value); },
  });
  function event(name: string, value: Record<string, unknown> = {}, context = ctx) {
    const handler = handlers.get(name);
    assert.ok(handler, `registered ${name}`);
    handler({ type: name, ...value }, context);
  }
  function start(command: string, id = "shell", extra = {}) {
    event("tool_execution_start", { toolCallId: id, toolName: "bash", args: { command, ...extra } });
  }
  function end(id = "shell", details: unknown = {}, isError = false, toolName = "bash", text = "") {
    event("tool_execution_end", { toolCallId: id, toolName, result: { details, content: [{ type: "text", text }] }, isError });
  }
  return {
    ctx, attention, crew, milestones, event, start, end, reset: observer.reset,
    enable(value: boolean) { enabled = value; },
    snapshot(value: unknown) { snapshot = value; },
    onCrew(value: (value: string) => void) { onCrew = value; },
  };
}

const commands = [
  ["npm test", "test", "TESTS PASSED"],
  ["npm run test -- --runInBand", "test", "TESTS PASSED"],
  ["cd '/tmp/a project' && pnpm test", "test", "TESTS PASSED"],
  ["yarn run test", "test", "TESTS PASSED"],
  ["bun test test/example.test.ts", "test", "TESTS PASSED"],
  ["node --test test/example.test.ts", "test", "TESTS PASSED"],
  ["cargo test --locked", "test", "TESTS PASSED"],
  ["go test ./...", "test", "TESTS PASSED"],
  ["python3 -m pytest -q", "test", "TESTS PASSED"],
  ["pytest -q test/", "test", "TESTS PASSED"],
  ["npx vitest run", "test", "TESTS PASSED"],
  ["npx jest --runInBand", "test", "TESTS PASSED"],
  ["npm run build", "build", undefined],
  ["pnpm build", "build", undefined],
  ["bun run build", "build", undefined],
  ["cargo build --release", "build", undefined],
  ["go build ./...", "build", undefined],
  ["git commit -m 'fix: literal ; $(not executed) # text'", undefined, "FIRST COMMIT"],
  ['git commit -m "fix: quoted text"', undefined, "FIRST COMMIT"],
  ["git commit --amend --no-edit", undefined, "FIRST COMMIT"],
] as const;

for (const [command, signal, milestone] of commands) {
  test(`confirmed direct command: ${command}`, () => {
    const h = harness();
    h.start(command, "shell", { name: null, ready: null, async: null });
    assert.deepEqual(h.crew, signal ? [signal] : []);
    assert.deepEqual(h.milestones, []);
    h.end(); // OMP's synchronous successful bash result omits exitCode.
    assert.deepEqual(h.crew, signal ? [signal, "pass"] : []);
    assert.deepEqual(h.milestones, milestone ? [milestone] : []);
  });
}

const excluded = [
  "echo 'npm test'", "printf 'TESTS PASSED'", "echo RELEASED", "git status", "git log -1", "git push",
  "npm pack", "npm publish --dry-run", "npm publish --dry-run=false", "npm publish --help",
  "npm test --help", "npm run test --if-present", "npm test --ignore-scripts", "npm test --script-shell=echo",
  "npm run build -- --help", "npm run test:list", "npm run release", "npm run test:help",
  "gh release list", "gh release view v1", "gh release create v1 --draft", "cargo publish --dry-run",
  "git commit --dry-run", "git commit --short", "git commit --porcelain", "git commit --long", "git commit -h",
  "pytest --collect-only", "pytest --co", "pytest --fixtures", "pytest --markers", "pytest --setup-plan",
  "cargo test --no-run", "cargo test -- --list", "go test -list .", "go test -list=.", "go test -c", "go build -n",
  "jest --listTests", "npx jest --showConfig", "jest --clearCache", "vitest", "vitest run --watch", "jest --passWithNoTests",
  "false && npm test", "true || npm test", "if false; then npm test; fi", "false; npm test", "npm test; true",
  "npm test && echo done", "npm test &", "npm test | cat", "npm test > /tmp/output", "# npm test", "npm test # not trusted",
  "echo hi\nnpm test", "sh -c 'npm test'", "bash -c 'git commit -m hi'", "eval 'npm publish'", "$(echo npm) test",
  'npm "te$NAME"', "npm `echo test`", 'git commit -m "$(echo x)"', "npm te\\st", "npm test 'unterminated",
  "env npm test", "CI=1 npm test", "command npm test", "nohup npm publish", "npm test --watchAll=true",
];

for (const command of excluded) {
  test(`does not infer success: ${command}`, () => {
    const h = harness();
    h.start(command);
    h.end();
    assert.deepEqual(h.crew, []);
    assert.deepEqual(h.milestones, []);
  });
}

test("stdout and prompts cannot manufacture a victory", () => {
  const h = harness();
  h.event("input", { source: "interactive", text: "npm publish: RELEASED; TESTS PASSED; git commit" });
  h.event("tool_execution_start", { toolCallId: "read", toolName: "read", args: { command: "npm test" } });
  h.event("tool_execution_end", { toolCallId: "read", toolName: "read", isError: false, result: { details: {}, content: [{ type: "text", text: "TESTS PASSED RELEASED [main abc123]" }] } });
  assert.deepEqual(h.crew, []);
  assert.deepEqual(h.milestones, []);
});

test("failed, timed out, cancelled and absent metadata are not successful exits", () => {
  for (const [details, isError] of [[{ exitCode: 1 }, false], [{}, true], [{ timedOut: true }, false], [{ cancelled: true }, false], [undefined, false]] as const) {
    const h = harness();
    h.start("npm test");
    if (details === undefined) h.event("tool_execution_end", { toolCallId: "shell", toolName: "bash", result: {}, isError });
    else h.end("shell", details, isError);
    assert.ok(!h.crew.includes("pass"));
    assert.deepEqual(h.milestones, []);
  }
});

test("service readiness and background spawning never count as completion", () => {
  for (const details of [
    { async: { state: "running", jobId: "bg_1", type: "bash" } },
    { async: { state: "cancelled", jobId: "bg_1", type: "bash" } },
    { async: { state: "failed", jobId: "bg_1", type: "bash" } },
    { service: { name: "release", ready: true, state: "running" } },
  ]) {
    const h = harness();
    h.start("npm publish");
    h.end("shell", details);
    assert.deepEqual(h.milestones, []);
  }
  for (const options of [{ async: true }, { name: "build" }, { ready: { port: 3000 } }]) {
    const h = harness();
    h.start("npm test", "shell", options);
    h.end();
    assert.deepEqual(h.crew, []);
    assert.deepEqual(h.milestones, []);
  }
});

test("FIRST COMMIT is stamped only once until reset", () => {
  const h = harness();
  h.start("git commit -m first"); h.end();
  h.start("git commit -m second"); h.end();
  assert.deepEqual(h.milestones, ["FIRST COMMIT"]);
  h.reset();
  h.start("git commit -m new-session"); h.end();
  assert.deepEqual(h.milestones, ["FIRST COMMIT", "FIRST COMMIT"]);
});

test("overlapping work retains the active crew and aggregates failures", () => {
  const h = harness();
  h.start("npm test", "test");
  h.start("npm run build", "build");
  h.end("test", { exitCode: 1 });
  assert.deepEqual(h.crew, ["test", "build"]);
  h.end("build");
  assert.deepEqual(h.crew, ["test", "build", "fail"]);
  assert.deepEqual(h.milestones, []);
  h.start("npm test", "fresh"); h.end("fresh");
  assert.equal(h.crew.at(-1), "pass");
  assert.deepEqual(h.milestones, ["TESTS PASSED"]);
});

test("tool_result and tool_execution_end are idempotent, matched by tool and id", () => {
  const h = harness();
  h.start("npm test");
  h.end("shell", {}, false, "other");
  assert.deepEqual(h.milestones, []);
  h.event("tool_result", { toolCallId: "shell", toolName: "bash", input: { command: "npm test" }, details: {}, content: [], isError: false });
  h.end();
  assert.deepEqual(h.milestones, ["TESTS PASSED"]);
  h.event("tool_result", { toolCallId: "unobserved", toolName: "bash", input: { command: "npm publish" }, details: {}, content: [], isError: false });
  assert.deepEqual(h.milestones, ["TESTS PASSED"]);
});

test("reset, disable and callback cancellation invalidate deferred results", () => {
  const h = harness();
  h.start("npm publish"); h.reset(); h.end();
  assert.deepEqual(h.milestones, []);
  h.start("npm publish"); h.enable(false); h.end(); h.enable(true); h.end();
  assert.deepEqual(h.milestones, []);
  h.onCrew(value => { if (value === "pass") h.reset(); });
  h.start("npm test"); h.end();
  assert.deepEqual(h.milestones, []);
});

test("subagents cannot start, finish, cancel or reset main-session activity", () => {
  const h = harness();
  const child = { ...h.ctx, agent: { kind: "subagent" } } as unknown as ExtensionContext;
  h.start("git commit -m main");
  for (const [name, value] of [
    ["input", { text: "do work", source: "interactive" }],
    ["before_agent_start", {}], ["agent_start", {}],
    ["tool_execution_start", { toolCallId: "shell", toolName: "bash", args: { command: "npm test" } }],
    ["tool_execution_end", { toolCallId: "shell", toolName: "bash", result: { details: {} }, isError: false }],
    ["tool_result", { toolCallId: "shell", toolName: "bash", details: {}, isError: false }],
    ["tool_approval_requested", { toolCallId: "child" }], ["tool_approval_resolved", { toolCallId: "child", approved: false }],
    ["message_end", { message: { role: "assistant", stopReason: "aborted" } }],
    ["agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }], ["session_shutdown", {}],
  ] as const) h.event(name, value, child);
  assert.deepEqual(h.milestones, []);
  h.end();
  assert.deepEqual(h.milestones, ["FIRST COMMIT"]);
});

test("interactive and RPC input wake activity; extension/bot input and commands do not", () => {
  const h = harness();
  h.event("input", { source: "extension", text: "bot message" });
  h.event("input", { source: "interactive", text: " /sticky fun on" });
  h.event("input", { source: "interactive", text: "   " });
  assert.deepEqual(h.attention, []);
  h.event("input", { source: "interactive", text: "work" });
  assert.deepEqual(h.attention, ["working"]);
  h.reset();
  h.event("input", { source: "rpc", text: "work" });
  assert.deepEqual(h.attention, ["working", "working"]);
});

test("asks and approvals remain waiting until every concurrent question settles", () => {
  const h = harness();
  h.event("agent_start");
  h.event("tool_execution_start", { toolCallId: "ask1", toolName: "ask", args: { html: "<form></form>" } });
  h.event("tool_execution_start", { toolCallId: "ask2", toolName: "ask", args: { html: "<form></form>" } });
  h.event("tool_approval_requested", { toolCallId: "approval" });
  h.end("ask1", {}, false, "ask");
  h.end("ask2", {}, false, "ask");
  assert.equal(h.attention.at(-1), "waiting");
  h.event("tool_approval_resolved", { toolCallId: "approval", approved: true });
  assert.equal(h.attention.at(-1), "working");
  h.event("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(h.attention.at(-1), "finished");
});

test("abort cleans pending asks and rejects their late shell results", () => {
  const h = harness();
  h.event("agent_start");
  h.start("npm publish");
  h.event("tool_execution_start", { toolCallId: "ask", toolName: "ask", args: {} });
  h.event("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
  assert.equal(h.attention.at(-1), "idle");
  h.end(); h.end("ask", {}, false, "ask");
  assert.deepEqual(h.milestones, []);
  assert.ok(!h.attention.includes("finished"));
});

test("only a successful terminal assistant settle is finished", () => {
  for (const stopReason of ["aborted", "error", "length", "toolUse"]) {
    const h = harness();
    h.event("agent_start");
    h.event("agent_end", { messages: [{ role: "assistant", stopReason }] });
    assert.ok(!h.attention.includes("finished"));
  }
  const h = harness();
  h.event("agent_start");
  h.start("npm test"); h.end("shell", { exitCode: 1 });
  h.event("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(h.attention.at(-1), "idle");
});

test("continuations, running jobs and pending publication delivery prevent fake victory", () => {
  const h = harness();
  h.event("agent_start");
  const messages = [{ role: "assistant", stopReason: "stop" }];
  h.event("agent_end", { messages, willContinue: true });
  h.event("agent_end", { messages, awaitingAsyncWork: true });
  for (const delivery of [
    { queued: 1, delivering: false, pendingJobIds: [] },
    { queued: 0, delivering: true, pendingJobIds: [] },
    { queued: 0, delivering: false, pendingJobIds: ["publication"] },
  ]) {
    h.snapshot({ running: [], recent: [], delivery });
    h.event("agent_end", { messages });
    assert.ok(!h.attention.includes("finished"));
  }
  h.snapshot({ running: [{ id: "publication", type: "bash", status: "running", startTime: 0 }], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } });
  h.event("agent_end", { messages });
  assert.ok(!h.attention.includes("finished"));
  h.snapshot(null);
  h.event("agent_end", { messages });
  assert.equal(h.attention.at(-1), "finished");
});

test("only npm's direct t alias means test; arbitrary t scripts do not", () => {
  const h = harness();
  for (const command of ["npm run t", "yarn t", "bun t", "pnpm run t"]) {
    h.start(command); h.end();
  }
  assert.deepEqual(h.milestones, []);
  h.start("npm t"); h.end("shell", { exitCode: 0 });
  assert.deepEqual(h.milestones, ["TESTS PASSED"]);
});

test("failed commits do not consume the first-confirmed-commit stamp", () => {
  const h = harness();
  h.start("git commit -m failed"); h.end("shell", { exitCode: 1 });
  assert.deepEqual(h.milestones, []);
  h.start("git commit -m confirmed"); h.end("shell", { exitCode: 0 });
  h.start("git commit -m later"); h.end();
  assert.deepEqual(h.milestones, ["FIRST COMMIT"]);
});

const npmPublished = `npm notice
npm notice 📦  example-package@1.2.3
npm notice Tarball Details
npm notice name: example-package
npm notice version: 1.2.3
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
+ example-package@1.2.3`;

const publicationFixtures = [
  ["npm publish --access public", npmPublished],
  ["pnpm publish", npmPublished],
  ["yarn publish", "[4/4] Publishing...\nsuccess Published.\nDone in 1.23s."],
  ["yarn npm publish", "➤ YN0000: Package successfully published\n➤ YN0000: Done in 0s 400ms"],
  ["cargo publish --locked", "   Uploading example-package v1.2.3\n    Uploaded example-package v1.2.3 to registry `crates-io`\n   Published example-package v1.2.3 at registry `crates-io`"],
  ["gh release create v1.2.3 --generate-notes", "https://github.com/example/project/releases/tag/v1.2.3"],
] as const;

for (const [command, output] of publicationFixtures) {
  test(`publication requires matching successful result evidence: ${command}`, () => {
    const h = harness();
    h.start(command, "shell", { name: null, ready: null, async: null });
    h.end();
    assert.deepEqual(h.milestones, []);
    h.start(command, "shell", { name: null, ready: null, async: null });
    h.end("shell", {}, false, "bash", output);
    assert.deepEqual(h.milestones, ["RELEASED"]);
    h.start(command);
    h.end("shell", { exitCode: 1 }, true, "bash", output);
    assert.deepEqual(h.milestones, ["RELEASED"]);
  });
}

test("real npm console shapes distinguish publication from processing and dry-run", () => {
  const unsuccessful = [
    "+ example-package@1.2.3",
    npmPublished.replace("access", "access (dry-run)"),
    npmPublished.replace("+ example-package", "npm notice Your package is being processed. You will receive an email when processing is complete.\n+ example-package"),
    `${npmPublished}\nnpm notice Publication is staged pending approval`,
    `${npmPublished}\nnpm notice Package was not published`,
    '{"id":"example-package@1.2.3","name":"example-package","version":"1.2.3"}',
  ];
  for (const output of unsuccessful) {
    const h = harness();
    h.start("npm publish");
    h.end("shell", {}, false, "bash", output);
    assert.deepEqual(h.milestones, [], output);
  }
});

test("inherited npm dry-run settings prevent publication stamps", () => {
  for (const key of ["npm_config_dry_run", "NPM_CONFIG_DRY_RUN"]) {
    const saved = process.env[key];
    try {
      process.env[key] = "true";
      const h = harness();
      h.start("npm publish");
      h.end("shell", {}, false, "bash", npmPublished);
      assert.deepEqual(h.milestones, []);
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  }
});

test("release dry-run, draft and staged modes cannot use positive output as evidence", () => {
  for (const command of [
    "npm publish --dry-run", "npm publish --dry-run=false", "npm publish --help", "npm pack",
    "yarn npm publish --dry-run", "cargo publish --dry-run",
    "gh release create v1.2.3 -d", "gh release create v1.2.3 --draft", "gh release create v1.2.3 --draft=false",
  ]) {
    const h = harness();
    h.start(command);
    h.end("shell", {}, false, "bash", publicationFixtures.map(([, output]) => output).join("\n"));
    assert.deepEqual(h.milestones, [], command);
  }
  for (const [command, output] of [
    ["cargo publish", "Uploaded example-package v1.2.3 to registry `crates-io`"],
    ["yarn publish", "[4/4] Publishing...\ninfo Publication pending"],
    ["gh release create v1.2.3", "https://github.com/example/project/releases/tag/untagged-12345"],
    ["gh release create v1.2.3", "Draft created\nhttps://github.com/example/project/releases/tag/v1.2.3"],
  ]) {
    const h = harness();
    h.start(command);
    h.end("shell", {}, false, "bash", output);
    assert.deepEqual(h.milestones, [], output);
  }
});

test("publication evidence is scoped to a live recognized shell invocation", () => {
  const h = harness();
  h.start("echo release");
  h.end("shell", {}, false, "bash", npmPublished);
  assert.deepEqual(h.milestones, []);
  h.start("npm publish");
  h.event("tool_result", { toolCallId: "shell", toolName: "bash", input: { command: "npm publish" }, details: {}, content: [{ type: "text", text: npmPublished }], isError: false });
  h.end("shell", {}, false, "bash", npmPublished);
  assert.deepEqual(h.milestones, ["RELEASED"]);
  h.start("npm publish");
  h.reset();
  h.end("shell", {}, false, "bash", npmPublished);
  assert.deepEqual(h.milestones, ["RELEASED"]);
});

for (const [command, signal, milestone] of [
  ["npm run check && npm test && npm run build", "build", "TESTS PASSED"],
  ["cd '/tmp/a project' && npm run lint && npm test", "test", "TESTS PASSED"],
  ["pnpm run typecheck && pnpm build && pnpm test", "test", "TESTS PASSED"],
  ["cargo build --locked && cargo test --locked", "test", "TESTS PASSED"],
  ["npm test && npm test", "test", "TESTS PASSED"],
  ["cd /tmp && npm run build", "build", undefined],
  ["git commit -m 'quoted && is not a separator'", undefined, "FIRST COMMIT"],
] as const) {
  test(`literal successful command chain: ${command}`, () => {
    const h = harness();
    h.start(command);
    assert.deepEqual(h.crew, signal ? [signal] : []);
    // Actual OMP 19 successful synchronous BashToolDetails: no exitCode.
    h.end("shell", { wallTimeNoticeEmitted: false, timeoutSeconds: 300, wallTimeMs: 42 });
    assert.deepEqual(h.crew, signal ? [signal, "pass"] : []);
    assert.deepEqual(h.milestones, milestone ? [milestone] : []);
  });
}

test("a failed or deferred command chain cannot prove any test passed", () => {
  for (const details of [{ exitCode: 1 }, { timedOut: true }, { async: { state: "running", jobId: "bg_1" } }]) {
    const h = harness();
    h.start("npm test && npm run build");
    h.end("shell", details);
    assert.ok(!h.crew.includes("pass"));
    assert.deepEqual(h.milestones, []);
  }
});

test("literal chains reject early exits, masked failures and non-executing modes", () => {
  for (const command of [
    "exit 0 && npm test", "exec true && npm test", "source setup && npm test",
    "npm test || true", "npm test; npm run build", "npm test && npm run build || true",
    "npm test && npm run release", "npm test && npm publish", "npm test && git commit -m done",
    "npm test --help && npm run build", "npm test && npm run build --dry-run",
    "npm run check --if-present && npm test", "npm test &&", "&& npm test",
    "npm 'test&&npm' test", "echo 'npm test && npm run build'",
  ]) {
    const h = harness();
    h.start(command); h.end();
    assert.deepEqual(h.crew, [], command);
    assert.deepEqual(h.milestones, [], command);
  }
});

test("filesystem edits are visible work, never successful tests", () => {
  for (const [toolName, args] of [
    ["edit", { input: "*** Begin Patch\n[src/example.ts#ABCD]\nPUT 1.=1:\n+export const n = 1;\n*** End Patch" }],
    ["edit", { path: "src/example.ts", old_string: "1", new_string: "2" }],
    ["edit", { input: "*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch" }],
    ["write", { path: "src/example.ts", content: "export const n = 1;" }],
    ["write", { path: "/tmp/example.ts", content: "" }],
    ["write", { path: "local://example.ts", content: "" }],
    ["functions.write", { path: "ssh://host/tmp/example.ts", content: "" }],
  ] as const) {
    const h = harness();
    h.event("tool_execution_start", { toolCallId: "edit", toolName, args });
    assert.deepEqual(h.crew, ["editing"]);
    h.event("tool_result", { toolCallId: "edit", toolName, input: args, content: [], details: undefined, isError: false });
    h.end("edit", {}, false, toolName);
    assert.deepEqual(h.crew, ["editing", "none"]);
    assert.deepEqual(h.milestones, []);
  }
});

test("control-plane write paths and eval code are not filesystem editing or proof", () => {
  for (const path of ["agent://Main", "proc://bg_1/kill", "out://", "xd://status", "xd://edit", "xd://bash", "xd://eval"]) {
    const h = harness();
    h.event("tool_execution_start", { toolCallId: "write", toolName: "write", args: { path, content: "help" } });
    h.end("write", {}, false, "write");
    assert.deepEqual(h.crew, [], path);
    assert.deepEqual(h.milestones, [], path);
  }
  const h = harness();
  h.event("tool_execution_start", { toolCallId: "eval", toolName: "eval", args: { language: "js", code: "if (false) await tool.bash({command: 'npm test'});" } });
  h.end("eval", { status: [{ op: "bash" }] }, false, "eval", "TESTS PASSED");
  assert.deepEqual(h.crew, []);
  assert.deepEqual(h.milestones, []);
});

test("mounted bash execution unwraps only the matched device's inner result", () => {
  for (const [xdev, isError, expected] of [
    [{ tool: "bash", mode: "execute", inner: { wallTimeNoticeEmitted: false, timeoutSeconds: 300 } }, false, true],
    [{ tool: "bash", mode: "execute", inner: { exitCode: 1 } }, false, false],
    [{ tool: "bash", mode: "execute", inner: { async: { state: "running", jobId: "bg_1" } } }, false, false],
    [{ tool: "bash", mode: "execute", inner: { service: { ready: true } } }, false, false],
    [{ tool: "bash", mode: "help", inner: {} }, false, false],
    [{ tool: "eval", mode: "execute", inner: {} }, false, false],
    [{ tool: "bash", mode: "execute" }, false, false],
    [{ tool: "bash", mode: "execute", inner: {} }, true, false],
  ] as const) {
    const h = harness();
    h.event("tool_execution_start", { toolCallId: "device", toolName: "write", args: { path: "xd://bash", content: JSON.stringify({ command: "npm run check && npm test" }) } });
    assert.deepEqual(h.crew, ["test"]);
    h.end("device", { xdev }, isError, "write");
    assert.deepEqual(h.milestones, expected ? ["TESTS PASSED"] : []);
    assert.equal(h.crew.includes("pass"), expected);
  }
});

test("mounted edits show editing, but help and malformed requests do not", () => {
  const h = harness();
  h.event("tool_execution_start", { toolCallId: "device", toolName: "write", args: { path: "xd://edit", content: JSON.stringify({ input: "[src/example.ts#ABCD]\nPUT 1.=1:\n+new\n" }) } });
  assert.deepEqual(h.crew, ["editing"]);
  h.end("device", { xdev: { tool: "edit", mode: "execute", inner: { diff: "" } } }, false, "write");
  assert.deepEqual(h.crew, ["editing", "none"]);
  assert.deepEqual(h.milestones, []);
});

test("parallel wrappers expose crew attempts without trusting aggregate success", () => {
  for (const [recipient_name, parameters, expected] of [
    ["functions.write", { path: "src/example.ts", content: "" }, "editing"],
    ["functions.edit", { input: "[src/example.ts#ABCD]\nPUT 1.=1:\n+new\n" }, "editing"],
    ["functions.bash", { command: "npm test" }, "test"],
    ["functions.bash", { command: "npm run build" }, "build"],
    ["functions.write", { path: "agent://Main", content: "hello" }, undefined],
    ["functions.read", { path: "src/example.ts" }, undefined],
    ["functions.bash", { command: "npm test", async: true }, undefined],
  ] as const) {
    const h = harness();
    h.event("tool_execution_start", { toolCallId: "parallel", toolName: "multi_tool_use.parallel", args: { tool_uses: [{ recipient_name, parameters }] } });
    assert.deepEqual(h.crew, expected ? [expected] : []);
    h.end("parallel", {}, false, "multi_tool_use.parallel", "TESTS PASSED");
    assert.deepEqual(h.crew, expected ? [expected, "none"] : []);
    assert.deepEqual(h.milestones, []);
  }
});

test("unrelated quick edits do not hide an active build or manufacture pass", () => {
  const h = harness();
  h.start("npm run build", "build");
  h.event("tool_execution_start", { toolCallId: "edit", toolName: "edit", args: { input: "[src/example.ts#ABCD]\nPUT 1.=1:\n+new\n" } });
  h.end("edit", {}, false, "edit");
  assert.deepEqual(h.crew, ["build", "editing", "build"]);
  h.end("build");
  assert.deepEqual(h.crew, ["build", "editing", "build", "pass"]);
  assert.deepEqual(h.milestones, []);
});

test("only recognizable filesystem edit targets show editing", () => {
  for (const args of [
    { input: "" }, { input: "help" }, { input: "*** Begin Patch\n*** End Patch" },
    { path: "agent://Main", old_string: "hello", new_string: "goodbye" },
    { input: "[proc://bg_1/kill#ABCD]\nPUT 1.=1:\n+stop\n" },
    { input: "*** Begin Patch\n*** Update File: agent://Main\n@@\n-old\n+new\n*** End Patch" },
  ]) {
    const h = harness();
    h.event("tool_execution_start", { toolCallId: "edit", toolName: "edit", args });
    h.end("edit", {}, false, "edit");
    assert.deepEqual(h.crew, []);
    assert.deepEqual(h.milestones, []);
  }
});

test("an error result cannot be promoted by a non-error execution envelope", () => {
  const h = harness();
  h.start("npm test");
  h.event("tool_execution_end", { toolCallId: "shell", toolName: "bash", isError: false, result: { isError: true, details: {}, content: [] } });
  assert.deepEqual(h.crew, ["test", "fail"]);
  assert.deepEqual(h.milestones, []);
});

test("an overlapping edit cannot discard an actual build failure", () => {
  const h = harness();
  h.start("npm run build", "build");
  h.event("tool_execution_start", { toolCallId: "edit", toolName: "edit", args: { path: "src/example.ts", old_string: "1", new_string: "2" } });
  h.end("build", { exitCode: 1 });
  h.end("edit", undefined, false, "edit");
  assert.deepEqual(h.crew, ["build", "editing", "fail"]);
  assert.deepEqual(h.milestones, []);
});
