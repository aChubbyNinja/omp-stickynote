import assert from "node:assert/strict";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, visibleWidth } from "@oh-my-pi/pi-tui";
import { StickyNote } from "../../src/note.ts";
import { cleanLabel } from "../../src/state.ts";
import { headlineLayout, MAX_PAPER_WIDTH, PAPER_WIDTH } from "../../src/paper.ts";

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
