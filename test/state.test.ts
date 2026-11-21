import assert from "node:assert/strict";
import test from "node:test";
import { cleanLabel, customTodoUpdates, ENTRY_TYPE, parseSaved, projectTasks, restore, sessionTitle, tasksFromPhases, todoSnapshot } from "../src/state.ts";
import { Effects } from "../src/effects.ts";

test("labels cannot inject colors, cursor motion, or terminal hyperlinks", () => {
  assert.equal(cleanLabel("\x1b[31mBuild\x1b[0m\n\x1b]8;;https://example.com\x07app\x1b]8;;\x07\u202e"), "Build app");
});

test("automatic headlines remove OMP icon tags without discarding meaningful title words", () => {
  assert.equal(sessionTitle("\u{f039a} STICKY: Test sticky note while scrolling"), "Test sticky note while scrolling");
  assert.equal(sessionTitle("⚙️ BUILD: Release dashboard"), "Release dashboard");
  assert.equal(sessionTitle("API: Preserve this heading"), "API: Preserve this heading");
  assert.equal(sessionTitle("Release dashboard"), "Release dashboard");
  assert.equal(sessionTitle("\u{f039a} STICKY: "), "Ready to begin");
});

test("the card projects three unfinished rows without dropping canonical completion history", () => {
  const tasks = tasksFromPhases([{ tasks: [
    { content: "Old", status: "completed" }, { content: "Dropped", status: "abandoned" },
    { content: "Build", status: "in_progress" }, { content: "Verify", status: "pending" },
    { content: "Publish", status: "pending" }, { content: "Later", status: "pending" },
  ] }]);
  assert.ok(tasks);
  assert.deepEqual(tasks.map(({ text, done }) => ({ text, done })), [
    { text: "Old", done: true },
    ...["Build", "Verify", "Publish", "Later"].map(text => ({ text, done: false })),
  ]);
  assert.deepEqual(projectTasks(tasks).map(task => task.text), ["Build", "Verify", "Publish"]);
  assert.equal(tasksFromPhases([{ tasks: [{ content: "Shipped", status: "completed" }] }])?.[0].done, true);
});

test("a successful clear supersedes old tasks; failed results and views do not", () => {
  const result = (phases: unknown, extra = {}) => ({ type: "message", message: {
    role: "toolResult", toolName: "todo", details: { phases }, ...extra,
  } });
  const old = result([{ tasks: [{ content: "Build", status: "pending" }] }]);
  assert.equal(restore([old, result([], { isError: true })]).tasks[0].text, "Build");
  assert.equal(restore([old, result([], { details: { op: "view", phases: [] } })]).tasks[0].text, "Build");
  assert.deepEqual(restore([old, result([])]).tasks, []);
  assert.deepEqual(restore([old, { type: "custom", customType: "user_todo_edit", data: { phases: [] } }]).tasks, []);
});

test("manual notes restore by branch and new sessions do not inherit them", () => {
  const saved = { version: 1, hidden: true, manual: { title: "Release", tasks: [{ text: "Ship", done: false }] } };
  const branch = [{ type: "custom", customType: ENTRY_TYPE, data: saved }];
  assert.deepEqual(restore(branch).saved, saved);
  assert.deepEqual(restore([]).saved, { version: 1, hidden: false, manual: null });
  assert.deepEqual(restore([...branch, { type: "custom", customType: ENTRY_TYPE, data: { ...saved, manual: null } }]).saved.manual, null);
  assert.equal(parseSaved({ ...saved, manual: { title: "Bad", tasks: [] } }), undefined);
  assert.equal(parseSaved({ ...saved, version: 2 }), undefined);
});

test("minimizing an existing branch preserves its checklist without hiding the note", () => {
  const pinned = { version: 1, hidden: false, manual: { title: "Release", tasks: [{ text: "Check", done: true }] } };
  const entry = (data: unknown) => ({ type: "custom", customType: ENTRY_TYPE, data });
  const branch = [entry(pinned), entry({ ...pinned, minimized: true })];
  assert.deepEqual(restore(branch).saved, { ...pinned, minimized: true });
  assert.deepEqual(restore(branch.slice(0, 1)).saved, pinned);
  assert.deepEqual(restore([...branch, entry({ ...pinned, minimized: false })]).saved, pinned);
});

test("batch completion retains identities even when the three displayed rows all change", () => {
  const phases = (status: string) => [{ name: "Ship", tasks: ["A", "B", "C", "D", "E", "F"]
    .map(content => ({ content, status })) }];
  const before = tasksFromPhases(phases("pending"))!;
  const after = tasksFromPhases(phases("completed"))!;
  assert.deepEqual(projectTasks(before).map(task => task.text), ["A", "B", "C"]);
  assert.deepEqual(projectTasks(after).map(task => task.text), ["D", "E", "F"]);
  assert.deepEqual(before.map(task => task.id), after.map(task => task.id));
  assert.equal(after.length, 6, "victory must compare the full list, not the unrelated display windows");
  assert.ok(after.every(task => task.done));
});

test("canonical identities distinguish phases, repeated occurrences, and sanitized labels", () => {
  const phases = [{ name: "First", tasks: [
    { content: "Build", status: "abandoned" }, { content: "Build", status: "pending" },
    { content: "\x1b[31mBuild\x1b[0m", status: "completed" },
  ] }, { name: "Second", tasks: [{ content: "Build", status: "completed" }] }];
  const before = tasksFromPhases(phases)!;
  const after = tasksFromPhases([{ ...phases[0], tasks: phases[0].tasks.map(task =>
    task.status === "pending" ? { ...task, status: "completed" } : task) }, phases[1]])!;
  assert.deepEqual(before.map(task => task.text), ["Build", "Build", "Build"]);
  assert.equal(new Set(before.map(task => task.id)).size, 3);
  assert.deepEqual(before.map(task => task.id), after.map(task => task.id));
});

test("host legacy blocked tasks restore as unfinished instead of reviving an older snapshot", () => {
  const branch = [{ type: "custom", customType: "user_todo_edit", data: {
    phases: [{ name: "Old plan", tasks: [{ content: "Waiting", status: "blocked" }] }],
  } }];
  assert.equal(restore(branch).tasks[0].text, "Waiting");
  assert.equal(restore(branch).tasks[0].done, false);
});

test("direct tool events and durable eval/manual edits preserve the same todo generation", () => {
  const phases = (status: string) => [{ name: "Tasks", tasks: [{ content: "Ship", status }] }];
  const result = (op: string, status: string, toolCallId: string, extra = {}) => ({
    type: "message", message: { role: "toolResult", toolName: "todo", toolCallId,
      details: { op, phases: phases(status), storage: "session" }, ...extra },
  });
  const init = result("init", "in_progress", "plan-1");
  const done = result("done", "completed", "done-1");
  const initial = restore([init]);
  const direct = todoSnapshot(done, initial.todo?.generation)!;
  const persisted = restore([init, done]);
  assert.deepEqual(direct, persisted.todo);
  assert.equal(initial.tasks[0].id, direct.tasks[0].id);
  const edit = { id: "eval-edit", type: "custom", customType: "user_todo_edit",
    data: { phases: phases("completed") } };
  assert.deepEqual(restore([init, edit]).tasks, direct.tasks, "eval bridge persists user_todo_edit, not a todo toolResult");
  assert.equal(todoSnapshot(result("done", "completed", "failed", { isError: true })), undefined);
  assert.equal(todoSnapshot(result("view", "completed", "view")), undefined);
  const unrelated = { ...done, message: { ...done.message, toolName: "sticky_note" } };
  assert.equal(todoSnapshot(unrelated), undefined);
  assert.deepEqual(restore([init, unrelated]).tasks, initial.tasks);
});

test("a skipped replacement init cannot turn identical labels from unrelated work into victory", () => {
  const result = (op: string, status: string, toolCallId: string, isError = false) => ({
    type: "message", message: { role: "toolResult", toolName: "todo", toolCallId, isError,
      details: { op, phases: [{ name: "Tasks", tasks: [{ content: "Build", status }] }] } },
  });
  const first = result("init", "pending", "first-plan");
  const second = result("init", "pending", "second-plan");
  const done = result("done", "completed", "second-done");
  const before = restore([first]);
  const after = restore([first, second, done]);
  assert.notEqual(before.tasks[0].id, after.tasks[0].id);
  assert.equal(after.todo?.generation, "second-plan");
  assert.equal(restore([first, result("init", "pending", "failed-init", true), done]).todo?.generation, "first-plan");
});

const evalTodo = (id: string, status: string) => ({
  type: "custom", customType: "user_todo_edit", id,
  data: { phases: [{ name: "Tasks", tasks: ["A", "B", "C", "D", "E", "F"]
    .map(content => ({ content, status })) }] },
});

test("eval initialization and completion between polls still produce visible victory for the full list", t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const effects = new Effects(() => {}, () => {});
  t.after(() => effects.dispose());
  effects.fun(true);
  effects.note({ title: "Ship", tasks: [], progress: [] }, true);
  const branch = [{ id: "observed-leaf", type: "custom", customType: "unrelated" },
    evalTodo("eval-init", "in_progress"), evalTodo("eval-done", "completed")];
  const updates = customTodoUpdates(branch, "observed-leaf")!;
  assert.equal(updates.length, 2);
  for (const update of updates) {
    effects.note({ title: "Ship", tasks: projectTasks(update.tasks), progress: update.tasks });
  }
  assert.equal(effects.frame.motion, "victory");
  assert.deepEqual(projectTasks(updates[0].tasks).map(task => task.text), ["A", "B", "C"]);
  assert.deepEqual(projectTasks(updates[1].tasks).map(task => task.text), ["D", "E", "F"]);
  t.mock.timers.tick(120);
  assert.deepEqual(customTodoUpdates(branch, "eval-done"), []);
  assert.equal(effects.frame.step, 1, "the next unchanged poll does not restart the celebration");
});

test("custom snapshot catch-up excludes loaded branches, navigation, and edits superseded by live direct results", () => {
  const init = evalTodo("eval-init", "in_progress");
  const done = evalTodo("eval-done", "completed");
  const direct = {
    id: "direct-result", type: "message", message: {
      role: "toolResult", toolName: "todo", toolCallId: "live-direct",
      details: { op: "init", phases: init.data.phases, storage: "session" },
    },
  };
  assert.equal(customTodoUpdates([init, done], undefined), undefined, "session loading is a baseline");
  assert.equal(customTodoUpdates([init, done], "sibling-leaf"), undefined, "branch navigation is a baseline");
  assert.deepEqual(customTodoUpdates([init, done, direct], "eval-init"), [],
    "the direct message_end has already observed and superseded earlier custom edits");
  const afterDirect = customTodoUpdates([init, done, direct, evalTodo("new-done", "completed")], "eval-init")!;
  assert.equal(afterDirect.length, 1);
  assert.equal(afterDirect[0].generation, "live-direct");
  assert.equal(afterDirect[0].source, "new-done");
});

test("catching up custom completions in boring mode never queues a victory for later", t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const effects = new Effects(() => {}, () => {});
  t.after(() => effects.dispose());
  effects.note({ title: "Ship", tasks: [], progress: [] }, true);
  for (const update of customTodoUpdates([
    evalTodo("eval-init", "in_progress"), evalTodo("eval-done", "completed"),
  ], null)!) {
    effects.note({ title: "Ship", tasks: projectTasks(update.tasks), progress: update.tasks });
  }
  effects.fun(true);
  assert.equal(effects.frame.motion, undefined);
});
