import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, TUI, type Component, type OverlayHandle, type Terminal } from "@oh-my-pi/pi-tui";
import { StickyNote } from "../../src/note.ts";
import { MinimizedNote } from "../../src/minimized.ts";

// Real bundled TUI: overlay composition, mode ownership, listener precedence,
// focus and suppression are exercised together instead of mocking the host.
export default async function pointerContract(pi: ExtensionAPI): Promise<void> {
  const previousProtocol = TERMINAL.imageProtocol;
  try {
    for (const protocol of [null, ImageProtocol.Sixel]) {
      for (const anchor of ["top-right", "top-center"] as const) {
        setTerminalImageProtocol(protocol);
        const modes = new Set<number>();
        const writes: string[] = [];
        const delivered: string[] = [];
        const observed: string[] = [];
        const terminal: Terminal = {
          columns: 100, rows: 32, kittyProtocolActive: false, kittyEnableSequence: null, appearance: undefined,
          start() {}, stop() {}, async drainInput() {},
          write(data) {
            writes.push(data);
            for (const match of data.matchAll(/\x1b\[\?(\d+)([hl])/g)) {
              if (match[2] === "h") modes.add(Number(match[1]));
              else modes.delete(Number(match[1]));
            }
          },
          moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
          setTitle() {}, setProgress() {}, onAppearanceChange() {},
        };
        const tui = new TUI(terminal);
        const editor: Component = { render: () => ["editor"], handleInput: input => delivered.push(input) };
        const modal: Component = { render: () => ["dialog"], handleInput: input => delivered.push(`modal:${input}`) };
        tui.addChild(editor);
        tui.setFocus(editor);
        tui.setInlineMouseTrackingProvider(() => true);
        tui.addInputListener(input => { observed.push(input); return undefined; });
        let minimized = 0;
        let restored = 0;
        let handle: OverlayHandle | undefined;
        let renderedGraphics = false;
        let error: unknown;
        const note = new StickyNote({ maxRows: () => 24, requestRender: () => tui.requestRender(), onError: value => { error = value; } });
        note.update({ title: "Release dashboard", tasks: [{ text: "Verify checkout", done: false }] });
        const tile = new MinimizedNote({ onRestore: () => { restored++; mountPaper(); } });
        const width = 48;
        const paperCol = () => anchor === "top-right" ? terminal.columns - 2 - width : 1 + Math.floor((terminal.columns - 3 - width) / 2);
        const mountPaper = () => {
          tile.deactivate();
          handle?.hide();
          const previous = tui.getFocused();
          handle = tui.showOverlay(note, { anchor, width, maxHeight: "100%", margin: { top: 0, right: 2, left: 1, bottom: 4 } });
          tui.overlayStack.find(entry => entry.component === note)!.released = true;
          tui.setFocus(previous);
          note.activate(tui, () => {
            minimized++;
            note.deactivate();
            handle?.hide();
            handle = tui.showOverlay(tile, tile.overlayOptions);
            tui.overlayStack.find(entry => entry.component === tile)!.released = true;
            tui.setFocus(editor);
            tile.activate(tui);
          });
          tui.renderNow();
        };
        // Same post-paint transport used by production: image control strings
        // never pass through the host's ANSI overlay slicer.
        const removeGraphics = tui.addPaintListener(frame => {
          if (frame.alt || !note.graphicsRows || !tui.overlayStack.some(entry => entry.component === note && !entry.hidden)) return;
          if (tui.overlayStack.some(entry => entry.component !== note && !entry.hidden)) return;
          for (const [row, line] of note.graphicsRows.entries()) terminal.write(`\x1b[${row + 1};${paperCol() + 1}H${line}`);
          renderedGraphics = true;
        });
        const report = (col: number, row: number, button = 0, suffix = "M") => `\x1b[<${button};${col + 1};${row + 1}${suffix}`;
        const press = (col = paperCol() + 12, row = 3) => tui.injectDebugInput(report(col, row));
        const release = (col = paperCol() + 12, row = 3) => tui.injectDebugInput(report(col, row, 0, "m"));
        const click = (col = paperCol() + 12, row = 3) => { press(col, row); release(col, row); };
        const double = (col = paperCol() + 12, row = 3) => { click(col, row); click(col, row); };
        try {
          mountPaper();
          if (protocol) {
            const deadline = Date.now() + 10_000;
            while (!renderedGraphics && !error && Date.now() < deadline) {
              await delay(10);
              tui.renderNow();
            }
            assert.ifError(error);
            assert.ok(renderedGraphics, "The real native SIXEL raster/encoder must settle");
            assert.ok(writes.some(line => TERMINAL.isImageLine(line)), "The graphic was emitted on the terminal surface");
          }
          assert.equal(tui.getFocused(), editor);
          assert.ok(modes.has(1000) && modes.has(1002) && modes.has(1006), "Expanded paper requests drag reports, not hover tracking");
          assert.ok(!modes.has(1003));
          click();
          assert.equal(minimized, 0, "One completed primary click never minimizes");
          tui.injectDebugInput("x");
          assert.equal(delivered.at(-1), "x", "Keyboard input retains editor routing");
          assert.equal(tui.getFocused(), editor);

          const outside = [report(paperCol() - 1, 3), report(paperCol() + width - 1, 3), report(0, 0), report(paperCol() + 12, 30), report(paperCol() + 12, 3, 64), report(paperCol() + 12, 3, 2), report(paperCol() + 12, 3, 4)];
          for (const input of outside) {
            const before = observed.length;
            tui.injectDebugInput(input);
            assert.equal(observed.length, before + 1, "Outside, gutter, shadow and nonprimary reports retain host routing");
            assert.equal(delivered.at(-1), input);
          }
          if (protocol) {
            double(paperCol(), 0);
            assert.equal(minimized, 0, "The graphics rectangle's transparent top-left gutter is not paper");
          } else {
            const rendered = note.render(width);
            double(paperCol() + 12, rendered.length - 1);
            assert.equal(minimized, 0, "ANSI bottom shadow is not paper");
          }
          click();
          await delay(450);
          click();
          assert.equal(minimized, 0, "Slow clicks are not a double click");
          tui.injectDebugInput("x");
          click();
          press();
          tui.injectDebugInput(report(paperCol() + 13, 3, 32));
          release();
          assert.equal(minimized, 0, "A motion report cancels even a drag returning to its start cell");
          click();
          press();
          release(paperCol() + 13, 3);
          assert.equal(minimized, 0, "A release on another cell is a drag, not a click");
          tui.injectDebugInput("x");
          click();
          press();
          assert.equal(minimized, 0, "The second press alone is not enough: its release may still be a drag");
          release();
          assert.equal(minimized, 1, "A completed primary double click on the painted paper minimizes");
          tui.renderNow();
          assert.equal(tui.getFocused(), editor);
          assert.ok(!modes.has(1002), "The restore tile drops expanded-paper drag tracking");
          press(terminal.columns - 5, 0);
          assert.equal(restored, 1, "The existing top-right tile still restores on a single press");
          assert.equal(tui.getFocused(), editor);

          click();
          const dialog = tui.showOverlay(modal, { width: 20, anchor: "center" });
          // Input arriving before its first paint must already be suppressed.
          double();
          assert.equal(minimized, 1, "A newly opened dialog blocks paper interaction immediately");
          tui.renderNow();
          assert.ok(!modes.has(1002) && !modes.has(1006));
          double();
          assert.equal(minimized, 1);
          dialog.hide();
          tui.renderNow();
          click();
          assert.equal(minimized, 1, "A dialog cancels the previous click sequence");
          tui.injectDebugInput("x");
          const fullscreen = tui.showOverlay(modal, { width: "100%", maxHeight: "100%", fullscreen: true });
          tui.renderNow();
          assert.ok(tui.getDebugPaint()!.altScreen);
          assert.ok(modes.has(1000) && modes.has(1003) && modes.has(1006), "Fullscreen modal mouse ownership survives suppression");
          double();
          assert.equal(minimized, 1);
          fullscreen.hide();
          tui.renderNow();
          assert.ok(!tui.getDebugPaint()!.altScreen);
          assert.equal(tui.getFocused(), editor);

          click();
          Object.defineProperty(terminal, "columns", { value: 120, configurable: true });
          double();
          assert.equal(minimized, 1, "Unpainted resize coordinates are rejected");
          tui.renderNow();
          double();
          assert.equal(minimized, 2, "The painted hit surface follows top-right and centered resize alignment");
          tui.renderNow();
          press(terminal.columns - 5, 0);
          assert.equal(restored, 2);
          note.deactivate();
          handle!.hide();
          tui.renderNow();
          assert.ok(modes.has(1000) && modes.has(1003) && modes.has(1006), "Removing all sticky overlays restores the unchanged host inline provider");
          double();
          assert.equal(minimized, 2, "Hidden/unmounted paper retains no input listener");
          mountPaper();
          note.dispose();
          double();
          assert.equal(minimized, 2, "Disposal drops the expanded click listener immediately");
        } finally {
          removeGraphics();
          note.dispose();
          tile.dispose();
          handle?.hide();
          tui.stop();
        }
      }
    }
  } finally {
    setTerminalImageProtocol(previousProtocol);
  }
  pi.on("session_start", (_event, ctx) => ctx.shutdown());
}
