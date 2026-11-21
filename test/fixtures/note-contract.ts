import assert from "node:assert/strict";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, visibleWidth } from "@oh-my-pi/pi-tui";
import { questionPaperRows, StickyNote } from "../../src/note.ts";
import { cleanLabel } from "../../src/state.ts";
import { headlineLayout, MAX_PAPER_WIDTH, PAPER_WIDTH } from "../../src/paper.ts";
import { OfficeBoard } from "../../src/board.ts";

// Run inside OMP so the production renderer uses its actual bundled TUI helpers.
// --trusted-extension makes an assertion failure abort startup with a nonzero exit.
export default async function noteContract(pi: ExtensionAPI): Promise<void> {
  const compact = headlineLayout("Release dashboard");
  assert.equal(compact.width, PAPER_WIDTH, "A title that fits two rows must not widen the card");
  assert.deepEqual(compact.lines, ["RELEASE", "DASHBOARD"]);
  const expanded = headlineLayout("Build team dashboard");
  assert.ok(expanded.width > PAPER_WIDTH && expanded.width < MAX_PAPER_WIDTH);
  assert.equal(expanded.lines.join(" "), "BUILD TEAM DASHBOARD", "Expansion must recover the previously truncated title");
  assert.equal(headlineLayout("Build team dashboard", expanded.width - 1).lines.length, 2);
  assert.match(headlineLayout("Build team dashboard", expanded.width - 1).lines[1], /…$/, "Expansion must stop at the smallest fitting width");
  const capped = headlineLayout("A very long project headline that cannot fit even after widening the sticky note");
  assert.equal(capped.width, MAX_PAPER_WIDTH);
  assert.equal(capped.lines.length, 2);
  assert.match(capped.lines[1], /…$/);
  assert.equal(headlineLayout("Build team dashboard", PAPER_WIDTH).width, PAPER_WIDTH, "Startup and narrow viewports must respect their width budget");
  assert.equal(headlineLayout("Ship").width, PAPER_WIDTH, "A shorter replacement title must restore the compact width");
  const note = new StickyNote();
  for (const width of [20, 38, 64]) {
    const welcome = note.render(width);
    assert.ok(welcome.every(row => !row.includes("[ ]") && !row.includes("[x]")), "A new session must not invent an empty task");
    assert.ok(welcome.every(row => visibleWidth(row) === width));
  }
  note.update({ title: "Release dashboard", tasks: [{ text: "Verify checkout", done: false }] });
  let text = note.render(38).map(cleanLabel).join("\n");
  assert.match(text, /RELEASE DASHBOARD/);
  const heading = note.render(38).find(row => row.includes("RELEASE DASHBOARD"));
  assert.ok(heading);
  const [before, after] = heading.split("RELEASE DASHBOARD");
  assert.ok(Math.abs(visibleWidth(before) - visibleWidth(after)) <= 2, "Headline must be centered, allowing the one-column shadow");
  assert.match(text, /\[ \] Verify checkout/);
  note.update({ title: "Release dashboard", tasks: [{ text: "Verify checkout", done: true }] });
  text = note.render(38).map(cleanLabel).join("\n");
  assert.match(text, /\[x\] Verify checkout/);
  note.update({ title: "Release dashboard", tasks: [] });
  text = note.render(38).map(cleanLabel).join("\n");
  assert.match(text, /RELEASE DASHBOARD/);
  assert.doesNotMatch(text, /\[[ x]\]/, "Clearing tasks must restore the empty state, not a blank checkbox");
  const activeFrame = { fun: true, attention: "working", crew: "build", step: 0, checks: [] } as const;
  const fullCard = { title: "Across the room", tasks: Array.from({ length: 3 }, () => ({ text: "A long task that wraps to a second line", done: false })) };
  note.update(fullCard, activeFrame);
  assert.ok(note.render(36).map(cleanLabel).some(row => /WORKING.*👷.*👷/.test(row)), "ANSI workers must share the status row");
  const waitingFrame = { ...activeFrame, attention: "waiting", crew: "none" } as const;
  const questionNote = {
    title: "Release dashboard",
    tasks: [{ text: "Verify checkout", done: true }, { text: "Ship release", done: false }],
  };
  const bluePaper = "\x1b[48;2;135;206;235m\x1b[38;2;16;38;75m";
  const yellowPaper = "\x1b[48;2;255;231;128m\x1b[38;2;41;38;22m";
  note.update(questionNote, waitingFrame);
  const waitingRows = note.render(38);
  const waitingText = waitingRows.map(cleanLabel).join("\n");
  for (const expected of ["ANSWER NEEDED", "RELEASE DASHBOARD", "[x] Verify checkout", "[ ] Ship release"]) {
    assert.ok(waitingText.includes(expected), `Waiting paper must preserve ${expected}`);
  }
  assert.ok(waitingRows.slice(0, -1).every(row => row.startsWith(bluePaper)), "The entire waiting paper, including borders and checklist, must be sky-blue with navy ink");
  note.update(questionNote, activeFrame);
  assert.ok(note.render(38).slice(0, -1).every(row => row.startsWith(yellowPaper)), "Answering must restore normal yellow paper");
  assert.ok(note.render(38).every(row => !row.includes("ANSWER NEEDED") && !row.includes(bluePaper)));
  for (const quietFrame of [
    { ...waitingFrame, fun: false },
    { ...waitingFrame, dnd: "DEEP WORK" as const },
    { ...waitingFrame, motion: "crumple" as const },
  ]) {
    note.update(questionNote, quietFrame);
    assert.ok(note.render(38).every(row => !row.includes(bluePaper) && !row.includes("ANSWER NEEDED")), "Fun-off, DND, and crumpling must suppress question styling");
  }
  const shortPane = new StickyNote({ maxRows: () => 4 });
  shortPane.update(fullCard, waitingFrame);
  assert.ok(shortPane.render(24).map(cleanLabel).some(row => row.includes("ANSWER NEEDED")), "Long tasks must not push a question off a short terminal");
  shortPane.update(fullCard, { ...activeFrame, attention: "finished", crew: "none", motion: "turnDone", step: 5 });
  assert.ok(shortPane.render(24).map(cleanLabel).some(row => row.includes("TURN DONE")), "Completion must stay legible in the same short pane");
  shortPane.dispose();
  note.dispose();

  const compactQuestion = questionPaperRows("Release dashboard", 38, 6);
  assert.ok(compactQuestion.slice(0, -1).every(row => row.startsWith(bluePaper)), "Form paper must reuse the waiting note's full blue surface and navy ink");
  assert.match(compactQuestion.map(cleanLabel).join("\n"), /ANSWER NEEDED\nRELEASE DASHBOARD/);
  const safeQuestion = questionPaperRows("\x1b]52;c;secret\x07Release dashboard", 38, 6);
  assert.deepEqual(safeQuestion, compactQuestion, "Form paper must sanitize terminal controls in project titles");
  for (const width of [1, 4, 8, 12, 24, 38, 64]) {
    for (const budget of [0, 1, 2, 3, 4, 5, 6, 12]) {
      const paper = questionPaperRows("项目 👩‍💻 dashboard", width, budget);
      assert.ok(paper.length <= Math.min(6, budget), "Compact paper must honor its row budget including decoration");
      assert.ok(paper.every(row => visibleWidth(row) === width), "Compact paper must honor the caller's width in terminal cells");
      assert.ok(paper.every(row => row.trimEnd().endsWith("\x1b[0m")), "Paper rows must not leak ANSI styling into form controls");
      assert.ok(paper.every(row => !/[\x00-\x1f\x7f-\x9f]/.test(row.replace(/\x1b\[[0-9;]*m/g, ""))), "Passive paper must contain no cursor, pointer, image, or terminal-mode controls");
      if (width >= 24 && budget > 0) assert.ok(paper.some(row => row.includes("ANSWER NEEDED")), "Even a one-row pane must retain the question heading when it fits");
      if (width >= 24 && budget >= 2) assert.ok(paper.some(row => row.includes("项目")), "Small panes must drop decoration before dropping the project title");
    }
  }
  assert.deepEqual(questionPaperRows("Project", 0, 6), []);
  assert.deepEqual(questionPaperRows("Project", Number.NaN, 6), []);
  assert.deepEqual(questionPaperRows("Project", 38, Number.NaN), []);
  assert.ok(questionPaperRows("Project", 24.9, 5.9).every(row => visibleWidth(row) === 24), "Fractional geometry must use whole terminal cells");

  const sessions = [
    { id: "local123456", name: "Desk", self: true, snapshot: { title: "Dashboard", attention: "working" as const, tasks: [{ text: "Render cards", done: true }] } },
    { id: "remote123456", name: "Laptop", self: false, snapshot: { title: "Release", attention: "waiting" as const, tasks: [{ text: "Review build", done: false }] } },
  ];
  const dashboard = new OfficeBoard({ sessions: () => sessions, rows: () => 24, requestRender() {}, close() {} });
  const dashboardText = dashboard.render(80).join("\n");
  for (const expected of ["SELF", "REMOTE", "Desk", "Laptop", "WORKING", "WAITING", "Dashboard", "Release", "[x] Render cards", "[ ] Review build"]) {
    assert.ok(dashboardText.includes(expected), `Dashboard must display ${expected}`);
  }
  dashboard.dispose();

  let requested = 0;
  let closed = 0;
  let boardSessions = Array.from({ length: 8 }, (_, i) => ({
    id: String(i), name: `设备${i}`, self: i === 0,
    snapshot: { title: `项目 👩‍💻 ${i} very long project description`, attention: "idle" as const,
      tasks: [{ text: "检查 Unicode 内容 with a long readable task label", done: false }] },
  }));
  const scrolling = new OfficeBoard({
    sessions: () => boardSessions, rows: () => 9,
    requestRender() { requested++; }, close() { closed++; },
  });
  const firstPage = scrolling.render(24);
  assert.equal(firstPage.length, 9);
  assert.ok(firstPage.every(row => visibleWidth(row) <= 24), "Dashboard must bound Unicode rows in terminal cells");
  scrolling.handleInput("j");
  assert.notDeepEqual(scrolling.render(24), firstPage, "Arrow/vim scrolling must move the viewport");
  scrolling.handleInput("\x1b[F");
  assert.notDeepEqual(scrolling.render(24), firstPage, "End must reach later session cards");
  scrolling.handleInput("\x1b[H");
  assert.deepEqual(scrolling.render(24), firstPage, "Home must restore the first session");
  boardSessions = [{ id: "fresh", name: "Fresh device", self: true,
    snapshot: { title: "Updated project", attention: "idle", tasks: [] } }];
  scrolling.refresh();
  scrolling.handleInput("\x1b[H");
  assert.ok(scrolling.render(40).join("\n").includes("Updated project"), "Refreshing must read current session snapshots");
  scrolling.handleInput("q");
  assert.equal(closed, 1, "q must close mission control");
  scrolling.dispose();
  const beforeDisposeRefresh = requested;
  scrolling.refresh();
  assert.equal(requested, beforeDisposeRefresh, "Disposed dashboards must stop requesting renders");

  let height = 12;
  const tiny = new OfficeBoard({
    sessions: () => [{ id: "safe", name: "Desk", self: true,
      snapshot: { title: "\x1b]52;c;secret\x07Safe project", attention: "idle", tasks: [] } }],
    rows: () => height, requestRender() {}, close() {},
  });
  const safeText = tiny.render(40).join("\n");
  assert.ok(safeText.includes("Safe project"));
  assert.ok(!safeText.includes("secret"), "Untrusted labels must not inject terminal controls");
  for (height of [1, 2, 3, 5]) {
    for (const width of [1, 4, 12, 40]) {
      const lines = tiny.render(width);
      assert.equal(lines.length, height, "Dashboard must fit the real viewport height");
      assert.ok(lines.every(row => visibleWidth(row) <= width), "Dashboard must fit the real viewport width");
    }
  }
  height = 2;
  assert.ok(tiny.render(40)[1]?.includes("Esc/q close"), "Tiny dashboards must keep the close hint visible");
  tiny.dispose();

  // SIXEL must bypass the host's text slicer or it appears as escape-code debris.
  const previousProtocol = TERMINAL.imageProtocol;
  setTerminalImageProtocol(ImageProtocol.Sixel);
  const ready = Promise.withResolvers<void>();
  const graphic = new StickyNote({
    maxRows: () => 18,
    onError: ready.reject,
    requestRender: () => {
      try {
        const overlayRows = graphic.render(54);
        if (!graphic.graphicsRows) return;
        assert.ok(overlayRows.every(row => !TERMINAL.isImageLine(row) && visibleWidth(row) === 54));
        assert.ok(graphic.graphicsRows.some(row => TERMINAL.isImageLine(row)));
        ready.resolve();
      } catch (error) { ready.reject(error); }
    },
  });
  const timeout = setTimeout(() => ready.reject(new Error("Native image rendering timed out")), 10_000);
  // Advance a single animation faster than rasterization/encoding. It must
  // deliver actual graphics while still moving, not only when updates stop.
  const workload = { title: "Building", tasks: [{ text: "Compile assets", done: false }] };
  const frame = { fun: true, attention: "working", crew: "build", checks: [], motion: "flutter", step: 0 } as const;
  let pose = 0;
  graphic.update(workload, frame);
  const motion = setInterval(() => {
    graphic.update(workload, { ...frame, step: ++pose % 6 });
    graphic.render(54);
  }, 4);
  try {
    assert.deepEqual(questionPaperRows("Release dashboard", 38, 6), compactQuestion, "Native image support must not turn form paper into an active or graphical component");
    graphic.render(54);
    graphic.update(workload, { ...frame, step: ++pose });
    graphic.render(54);
    await ready.promise;
    graphic.update({ title: "A different project", tasks: [] });
    assert.equal(graphic.graphicsRows, undefined, "A new project must never display the previous raster");
  } finally {
    clearInterval(motion);
    clearTimeout(timeout);
    graphic.dispose();
    setTerminalImageProtocol(previousProtocol);
  }
  pi.on("session_start", (_event, ctx) => ctx.shutdown());
}
