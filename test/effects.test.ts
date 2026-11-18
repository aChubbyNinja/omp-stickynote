import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Effects, type VisualFrame } from "../src/effects.ts";
import type { Note } from "../src/state.ts";

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const events = { changed: 0, crumpled: 0 };
  const effects = new Effects(() => events.changed++, () => events.crumpled++);
  t.after(() => effects.dispose());
  return { effects, events };
}

const unfinished: Note = { title: "Ship", tasks: [{ text: "Publish", done: false }] };
const finished: Note = { title: "Ship", tasks: [{ text: "Publish", done: true }] };

test("quiet defaults track live state without timers or replay on enabling fun", t => {
  const { effects, events } = harness(t);
  assert.deepEqual(effects.frame, {
    fun: false, attention: "idle", crew: "none", step: 0, checks: [],
    stamp: undefined, dnd: undefined, motion: undefined,
  });
  effects.attention("waiting");
  effects.crew("build");
  effects.note(unfinished, true);
  effects.note(finished);
  effects.milestone("RELEASED");
  effects.wave();
  t.mock.timers.tick(10_000);
  assert.equal(events.changed, 0);
  effects.fun(true);
  assert.equal(effects.frame.attention, "waiting");
  assert.equal(effects.frame.crew, "build");
  assert.equal(effects.frame.motion, undefined);
  assert.equal(effects.frame.stamp, undefined);
  assert.deepEqual(effects.frame.checks, []);
});

test("baseline and first completed snapshots never celebrate", t => {
  const { effects, events } = harness(t);
  effects.fun(true);
  effects.note(finished);
  assert.equal(effects.frame.motion, undefined);
  effects.note(unfinished, true);
  effects.note(finished, true);
  effects.note(finished);
  const changes = events.changed;
  t.mock.timers.tick(10_000);
  assert.equal(events.changed, changes);
  assert.equal(effects.frame.motion, undefined);
});

test("finishing a real list celebrates and keeps newly checked row indexes", t => {
  const { effects, events } = harness(t);
  effects.fun(true);
  effects.note({ title: "Ship", tasks: [
    { text: "Build", done: false }, { text: "Test", done: true }, { text: "Publish", done: false },
  ] }, true);
  const done: Note = { title: "Ship", tasks: [
    { text: "Build", done: true }, { text: "Test", done: true }, { text: "Publish", done: true },
  ] };
  effects.note(done);
  assert.equal(effects.frame.motion, "victory");
  assert.deepEqual(effects.frame.checks, [0, 2]);
  t.mock.timers.tick(120);
  assert.equal(effects.frame.step, 1);
  effects.note(done);
  assert.equal(effects.frame.step, 1, "repeated snapshots must not restart animation");
  effects.attention("waiting");
  effects.crew("pass");
  effects.wave();
  effects.milestone("TESTS PASSED");
  assert.equal(effects.frame.motion, "victory");
  assert.deepEqual(effects.frame.checks, [0, 2]);
  t.mock.timers.tick(10_000);
  assert.equal(effects.frame.motion, undefined);
  assert.deepEqual(effects.frame.checks, []);
  assert.equal(events.crumpled, 0);
  const changes = events.changed;
  t.mock.timers.tick(10_000);
  assert.equal(events.changed, changes);
});

test("effects own their baseline copy rather than retaining mutable saved note objects", t => {
  const { effects } = harness(t);
  const note: Note = { title: "Ship", tasks: [{ text: "Publish", done: false }] };
  effects.fun(true);
  effects.note(note, true);
  note.tasks[0].done = true;
  effects.note(note);
  assert.equal(effects.frame.motion, "victory");
  assert.deepEqual(effects.frame.checks, [0]);
  assert.equal(Object.isFrozen(effects.frame.checks), true);
});

test("unrelated titles or tasks, empty lists, and removed unfinished rows never win", t => {
  const { effects } = harness(t);
  effects.fun(true);
  for (const [before, after] of [
    [unfinished, { ...finished, title: "Different project" }],
    [unfinished, { title: "Ship", tasks: [{ text: "Unrelated", done: true }] }],
    [{ title: "Ship", tasks: [] }, finished],
    [unfinished, { title: "Ship", tasks: [] }],
    [{ title: "Ship", tasks: [{ text: "Publish", done: false }, { text: "Verify", done: false }] }, finished],
  ] satisfies [Note, Note][]) {
    effects.note(before, true);
    effects.note(after);
    assert.notEqual(effects.frame.motion, "victory");
  }
});

test("completion recognizes the host's projected or reordered task rows", t => {
  const { effects } = harness(t);
  effects.fun(true);
  effects.note(unfinished, true);
  effects.note({ title: "Ship", tasks: [{ text: "Build", done: true }, { text: "Publish", done: true }] });
  assert.equal(effects.frame.motion, "victory");
  assert.deepEqual(effects.frame.checks, [1]);
  effects.note({ title: "Ship", tasks: [{ text: "A", done: false }, { text: "B", done: false }] }, true);
  effects.note({ title: "Ship", tasks: [{ text: "B", done: true }, { text: "A", done: true }] });
  assert.equal(effects.frame.motion, "victory");
  assert.deepEqual(effects.frame.checks, [0, 1]);
});

test("duplicate task labels consume distinct prior rows", t => {
  const { effects } = harness(t);
  effects.fun(true);
  effects.note({ title: "Ship", tasks: [{ text: "Check", done: false }, { text: "Check", done: false }] }, true);
  effects.note({ title: "Ship", tasks: [{ text: "Check", done: true }] });
  assert.equal(effects.frame.motion, "check");
  assert.deepEqual(effects.frame.checks, [0]);
  effects.note({ title: "Ship", tasks: [{ text: "Check", done: true }, { text: "Check", done: false }] }, true);
  effects.note({ title: "Ship", tasks: [{ text: "Check", done: true }, { text: "Check", done: true }] });
  assert.equal(effects.frame.motion, "victory");
  assert.deepEqual(effects.frame.checks, [1]);
});

test("starting unrelated work clears old victory checks", t => {
  const { effects } = harness(t);
  effects.fun(true);
  effects.note(unfinished, true);
  effects.note(finished);
  effects.note({ title: "Next", tasks: [{ text: "Start", done: false }] });
  assert.equal(effects.frame.motion, "flutter");
  assert.deepEqual(effects.frame.checks, []);
});

test("waiting pulses briefly and has no idle ticks or repeated-snapshot restart", t => {
  const { effects, events } = harness(t);
  effects.fun(true);
  effects.attention("waiting");
  assert.equal(effects.frame.motion, "pulse");
  t.mock.timers.tick(120);
  assert.equal(effects.frame.step, 1);
  effects.attention("waiting");
  assert.equal(effects.frame.step, 1);
  t.mock.timers.tick(10_000);
  assert.equal(effects.frame.attention, "waiting");
  assert.equal(effects.frame.motion, undefined);
  const changes = events.changed;
  t.mock.timers.tick(10_000);
  assert.equal(events.changed, changes);
  effects.attention("working");
  effects.attention("waiting");
  effects.attention("idle");
  assert.equal(effects.frame.motion, undefined);
});

test("live crews move finitely, and pass/fail crews expire without stale timers", t => {
  const { effects, events } = harness(t);
  effects.fun(true);
  effects.crew("build");
  assert.equal(effects.frame.motion, "flutter");
  t.mock.timers.tick(1000);
  assert.equal(effects.frame.crew, "build");
  assert.equal(effects.frame.motion, undefined);
  const changes = events.changed;
  t.mock.timers.tick(10_000);
  assert.equal(events.changed, changes);
  effects.crew("pass");
  t.mock.timers.tick(2000);
  effects.crew("test");
  t.mock.timers.tick(1000);
  assert.equal(effects.frame.crew, "test", "old result expiry cannot clear a new crew");
  for (const result of ["pass", "fail"] as const) {
    effects.crew(result);
    t.mock.timers.tick(1000);
    assert.equal(effects.frame.crew, result);
    assert.equal(effects.frame.motion, undefined);
    t.mock.timers.tick(2000);
    assert.equal(effects.frame.crew, "none");
  }
});

test("milestone stamps expire and replacing them cancels the prior expiry", t => {
  const { effects } = harness(t);
  effects.fun(true);
  effects.milestone("FIRST COMMIT");
  t.mock.timers.tick(3000);
  effects.milestone("RELEASED");
  t.mock.timers.tick(1500);
  assert.equal(effects.frame.stamp, "RELEASED");
  t.mock.timers.tick(3000);
  assert.equal(effects.frame.stamp, undefined);
});

test("disabling fun cancels animation, result, and stamp timers without replay", t => {
  const { effects, events } = harness(t);
  effects.fun(true);
  effects.crew("pass");
  effects.milestone("RELEASED");
  effects.fun(false);
  assert.equal(effects.frame.motion, undefined);
  assert.equal(effects.frame.stamp, undefined);
  assert.equal(effects.frame.crew, "none");
  const changes = events.changed;
  t.mock.timers.tick(10_000);
  assert.equal(events.changed, changes);
  effects.fun(true);
  assert.equal(effects.frame.motion, undefined);
  assert.equal(effects.frame.stamp, undefined);
});

test("DND stays quiet while tracking current activity and never replays suppressed effects", t => {
  const { effects, events } = harness(t);
  effects.fun(true);
  effects.note(unfinished, true);
  effects.crew("pass");
  effects.milestone("FIRST COMMIT");
  effects.dnd("DEEP WORK");
  effects.note(finished);
  effects.attention("waiting");
  effects.crew("test");
  effects.milestone("RELEASED");
  effects.wave();
  assert.equal(effects.frame.motion, undefined);
  assert.equal(effects.frame.crew, "none");
  assert.equal(effects.frame.stamp, undefined);
  const changes = events.changed;
  t.mock.timers.tick(10_000);
  assert.equal(events.changed, changes);
  effects.dnd("WAITING ON A BUILD");
  assert.equal(effects.frame.dnd, "WAITING ON A BUILD");
  effects.dnd(undefined);
  assert.equal(effects.frame.crew, "test");
  assert.equal(effects.frame.attention, "waiting");
  assert.equal(effects.frame.motion, undefined);
  assert.deepEqual(effects.frame.checks, []);
  effects.note(finished);
  assert.equal(effects.frame.motion, undefined);
});

test("DND does not enable fun", t => {
  const { effects } = harness(t);
  effects.dnd("DEEP WORK");
  assert.equal(effects.frame.fun, false);
  effects.dnd(undefined);
  assert.equal(effects.frame.fun, false);
});

test("explicit crumple works when fun is off, cannot be interrupted, and dismisses only once", t => {
  const { effects, events } = harness(t);
  effects.note(unfinished, true);
  effects.crumple();
  assert.equal(effects.frame.fun, false);
  assert.equal(effects.frame.motion, "crumple");
  t.mock.timers.tick(120);
  effects.fun(true);
  effects.note(finished);
  effects.attention("waiting");
  effects.crew("pass");
  effects.milestone("RELEASED");
  effects.wave();
  effects.crumple();
  effects.fun(false);
  effects.dnd("DEEP WORK");
  assert.equal(effects.frame.motion, "crumple");
  assert.equal(effects.frame.step, 1);
  assert.deepEqual(effects.frame.checks, []);
  t.mock.timers.tick(10_000);
  assert.equal(events.crumpled, 1);
  assert.equal(effects.frame.motion, undefined);
  assert.equal(unfinished.tasks[0].done, false);
  const changes = events.changed;
  t.mock.timers.tick(10_000);
  assert.equal(events.crumpled, 1);
  assert.equal(events.changed, changes);
});

test("explicit baseline/show cancels a pending dismissal while preserving session modes", t => {
  const { effects, events } = harness(t);
  effects.fun(true);
  effects.attention("working");
  effects.dnd("DEEP WORK");
  effects.crumple();
  t.mock.timers.tick(120);
  effects.note(unfinished, true);
  assert.equal(effects.frame.motion, undefined);
  assert.equal(effects.frame.fun, true);
  assert.equal(effects.frame.dnd, "DEEP WORK");
  t.mock.timers.tick(10_000);
  assert.equal(events.crumpled, 0);
  effects.dnd(undefined);
  assert.equal(effects.frame.attention, "working");
});

test("dispose cancels every timer and future method calls cannot notify or dismiss", t => {
  const { effects, events } = harness(t);
  effects.fun(true);
  effects.crew("pass");
  effects.milestone("RELEASED");
  effects.crumple();
  effects.dispose();
  effects.dispose();
  const changes = events.changed;
  effects.fun(false);
  effects.dnd("DEEP WORK");
  effects.note(finished);
  effects.attention("waiting");
  effects.crew("test");
  effects.milestone("FIRST COMMIT");
  effects.wave();
  effects.crumple();
  t.mock.timers.tick(10_000);
  assert.equal(events.changed, changes);
  assert.equal(events.crumpled, 0);
  assert.equal(effects.frame.motion, undefined);
});

test("separate sessions cannot share baselines, modes, or dismissal callbacks", t => {
  const { effects, events } = harness(t);
  const otherEvents = { changed: 0, crumpled: 0 };
  const other = new Effects(() => otherEvents.changed++, () => otherEvents.crumpled++);
  t.after(() => other.dispose());
  effects.fun(true);
  effects.note(unfinished, true);
  other.fun(true);
  other.note(finished);
  assert.equal(other.frame.motion, undefined);
  effects.note(finished);
  assert.equal(effects.frame.motion, "victory");
  other.dnd("DEEP WORK");
  other.crumple();
  assert.equal(effects.frame.dnd, undefined);
  t.mock.timers.tick(10_000);
  assert.equal(events.crumpled, 0);
  assert.equal(otherEvents.crumpled, 1);
});

test("motion steps are discrete and bounded, with dismissal exactly after the final frame", t => {
  const { effects, events } = harness(t);
  effects.crumple();
  assert.equal(effects.frame.step, 0);
  t.mock.timers.tick(119);
  assert.equal(effects.frame.step, 0);
  for (let step = 1; step <= 5; step++) {
    t.mock.timers.tick(step === 1 ? 1 : 120);
    assert.equal(effects.frame.motion, "crumple");
    assert.equal(effects.frame.step, step);
    assert.equal(events.crumpled, 0);
  }
  t.mock.timers.tick(119);
  assert.equal(effects.frame.step, 5);
  t.mock.timers.tick(1);
  assert.equal(effects.frame.motion, undefined);
  assert.equal(effects.frame.step, 0);
  assert.equal(events.crumpled, 1);
});

test("new work flutters without a note change and yields immediately to a waiting pulse", t => {
  const { effects, events } = harness(t);
  effects.fun(true);
  effects.note(unfinished, true);
  effects.attention("working");
  assert.equal(effects.frame.motion, "flutter");
  t.mock.timers.tick(120);
  assert.equal(effects.frame.step, 1);
  effects.note(unfinished);
  effects.attention("working");
  assert.equal(effects.frame.step, 1, "repeated work snapshots must not restart the flutter");
  effects.attention("waiting");
  assert.equal(effects.frame.motion, "pulse");
  assert.equal(effects.frame.step, 0);
  t.mock.timers.tick(120);
  effects.attention("working");
  assert.equal(effects.frame.motion, "flutter");
  assert.equal(effects.frame.step, 0);
  t.mock.timers.tick(720);
  assert.equal(effects.frame.motion, undefined);
  const changes = events.changed;
  t.mock.timers.tick(10_000);
  assert.equal(events.changed, changes);
  effects.attention("waiting");
  assert.equal(effects.frame.motion, "pulse");
  effects.attention("idle");
  assert.equal(effects.frame.motion, undefined);
});

test("milestone stamps never imply task-list victory while work remains unfinished", t => {
  const { effects, events } = harness(t);
  effects.fun(true);
  effects.note(unfinished, true);
  for (const stamp of ["FIRST COMMIT", "TESTS PASSED", "RELEASED"] as const) {
    effects.milestone(stamp);
    assert.equal(effects.frame.stamp, stamp);
    assert.equal(effects.frame.motion, undefined);
    assert.deepEqual(effects.frame.checks, []);
    t.mock.timers.tick(4200);
    assert.equal(effects.frame.stamp, undefined);
  }
  const changes = events.changed;
  t.mock.timers.tick(10_000);
  assert.equal(events.changed, changes);
  effects.note(finished);
  assert.equal(effects.frame.motion, "victory", "task completion still owns project victory");
  effects.milestone("TESTS PASSED");
  assert.equal(effects.frame.motion, "victory");
  assert.deepEqual(effects.frame.checks, [0]);
});

test("frame identity is stable until visible changes and callbacks observe the new frame", t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const observed: VisualFrame[] = [];
  const effects = new Effects(() => observed.push(effects.frame), () => {});
  t.after(() => effects.dispose());
  const initial = effects.frame;
  assert.equal(effects.frame, initial);
  effects.note(unfinished, true);
  effects.attention("working");
  effects.crew("build");
  assert.equal(effects.frame, initial, "hidden activity must not invalidate the frame");
  effects.fun(true);
  const enabled = effects.frame;
  assert.notEqual(enabled, initial);
  assert.equal(observed.at(-1), enabled);
  assert.equal(enabled.attention, "working");
  assert.equal(enabled.crew, "build");
  effects.fun(true);
  effects.note(unfinished);
  assert.equal(effects.frame, enabled);
  effects.attention("waiting");
  const waiting = effects.frame;
  assert.notEqual(waiting, enabled);
  assert.equal(observed.at(-1), waiting);
  assert.equal(waiting.motion, "pulse");
  t.mock.timers.tick(119);
  assert.equal(effects.frame, waiting);
  t.mock.timers.tick(1);
  const advanced = effects.frame;
  assert.notEqual(advanced, waiting);
  assert.equal(observed.at(-1), advanced);
  assert.equal(advanced.step, 1);
  assert.equal(waiting.step, 0, "previous snapshots remain unchanged");
  effects.dnd("DEEP WORK");
  const quiet = effects.frame;
  effects.attention("working");
  effects.crew("test");
  effects.note(finished);
  effects.milestone("RELEASED");
  effects.wave();
  t.mock.timers.tick(10_000);
  assert.equal(effects.frame, quiet);
  effects.dnd(undefined);
  assert.notEqual(effects.frame, quiet);
  assert.equal(observed.at(-1), effects.frame);
  assert.equal(effects.frame.attention, "working");
  assert.equal(effects.frame.crew, "test");
  assert.equal(effects.frame.motion, undefined);
});

test("concurrent effects that cannot change a crumple preserve frame identity", t => {
  const { effects, events } = harness(t);
  effects.fun(true);
  effects.note(unfinished, true);
  effects.crumple();
  const crumpling = effects.frame;
  const changes = events.changed;
  effects.note(finished);
  effects.wave();
  effects.crumple();
  assert.equal(effects.frame, crumpling);
  assert.equal(events.changed, changes);
  t.mock.timers.tick(120);
  assert.notEqual(effects.frame, crumpling);
  assert.equal(effects.frame.step, 1);
});
