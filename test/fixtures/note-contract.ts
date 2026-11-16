import assert from "node:assert/strict";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, visibleWidth } from "@oh-my-pi/pi-tui";
import { StickyNote } from "../../src/note.ts";
import { cleanLabel } from "../../src/state.ts";

// Run inside OMP so the production renderer uses its actual bundled TUI helpers.
// --trusted-extension makes an assertion failure abort startup with a nonzero exit.
export default async function noteContract(pi: ExtensionAPI): Promise<void> {
  const note = new StickyNote();
  for (const width of [20, 38, 64]) {
    const welcome = note.render(width);
    assert.ok(welcome.every(row => !row.includes("[ ]") && !row.includes("[x]")), "A new session must not invent an empty task");
    assert.ok(welcome.every(row => visibleWidth(row) === width));
  }
  note.update({ title: "Release dashboard", tasks: [{ text: "Verify checkout", done: false }] });
  let text = note.render(38).map(cleanLabel).join("\n");
  assert.match(text, /Release dashboard/);
  assert.match(text, /\[ \] Verify checkout/);
  note.update({ title: "Release dashboard", tasks: [{ text: "Verify checkout", done: true }] });
  text = note.render(38).map(cleanLabel).join("\n");
  assert.match(text, /\[x\] Verify checkout/);
  note.update({ title: "Release dashboard", tasks: [] });
  text = note.render(38).map(cleanLabel).join("\n");
  assert.match(text, /Release dashboard/);
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
