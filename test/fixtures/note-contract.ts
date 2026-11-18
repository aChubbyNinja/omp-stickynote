import assert from "node:assert/strict";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, visibleWidth } from "@oh-my-pi/pi-tui";
import { StickyNote } from "../../src/note.ts";
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
  note.dispose();

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
  try {
    graphic.render(54);
    await ready.promise;
    graphic.update({ title: "A different project", tasks: [] });
    assert.equal(graphic.graphicsRows, undefined, "A new project must never display the previous raster");
  } finally {
    clearTimeout(timeout);
    graphic.dispose();
    setTerminalImageProtocol(previousProtocol);
  }
  pi.on("session_start", (_event, ctx) => ctx.shutdown());
}
