import assert from "node:assert/strict";
import test from "node:test";
import { cleanLabel, ENTRY_TYPE, parseSaved, restore, sessionTitle, tasksFromPhases } from "../src/state.ts";

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

test("only three unfinished tasks remain; completed and abandoned work does not crowd them out", () => {
  const tasks = tasksFromPhases([{ tasks: [
    { content: "Old", status: "completed" }, { content: "Dropped", status: "abandoned" },
    { content: "Build", status: "in_progress" }, { content: "Verify", status: "pending" },
    { content: "Publish", status: "pending" }, { content: "Later", status: "pending" },
  ] }]);
  assert.deepEqual(tasks, ["Build", "Verify", "Publish"].map(text => ({ text, done: false })));
  assert.deepEqual(tasksFromPhases([{ tasks: [{ content: "Shipped", status: "completed" }] }]), [{ text: "Shipped", done: true }]);
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
