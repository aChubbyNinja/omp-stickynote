import assert from "node:assert/strict";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, TUI, visibleWidth, type Component, type OverlayHandle, type Terminal } from "@oh-my-pi/pi-tui";
import { MinimizedNote } from "../../src/minimized.ts";

// Execute in OMP, not Node: this exercises the actual bundled overlay composer,
// input-listener ordering, passive-overlay focus routing and mouse mode owner.
export default function minimizedContract(pi: ExtensionAPI): void {
  const previousProtocol = TERMINAL.imageProtocol;
  try {
    for (const protocol of [null, ImageProtocol.Sixel]) {
      setTerminalImageProtocol(protocol);
      const modes = new Set<number>();
      const writes: string[] = [];
      const terminal: Terminal = {
        columns: 80, rows: 24, kittyProtocolActive: false, kittyEnableSequence: null, appearance: undefined,
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
      const delivered: string[] = [];
      const observed: string[] = [];
      const editor: Component = { render: () => ["editor"], handleInput: data => delivered.push(data) };
      const modal: Component = { render: () => ["dialog"], handleInput: data => delivered.push(`modal:${data}`) };
      let restored = 0;
      const tile = new MinimizedNote({ onRestore: () => { restored++; } });
      tui.addChild(editor);
      tui.setFocus(editor);
      tui.setInlineMouseTrackingProvider(() => true);
      tui.addInputListener(data => { observed.push(data); return undefined; });
      let handle: OverlayHandle | undefined;
      const mount = () => {
        const previous = tui.getFocused();
        handle = tui.showOverlay(tile, tile.overlayOptions);
        tui.overlayStack.find(entry => entry.component === tile)!.released = true;
        tui.setFocus(previous);
        tile.activate(tui);
        tui.renderNow();
      };
      const click = (col: number, row = 0, button = 0, suffix = "M") => `\x1b[<${button};${col + 1};${row + 1}${suffix}`;
      try {
        tui.renderNow();
        assert.ok(modes.has(1003), "The host's existing inline tracking is initially on");
        mount();
        assert.equal(tui.getFocused(), editor, "Mounting a released tile retains editor focus");
        assert.ok(modes.has(1000) && modes.has(1006), "A normal-buffer passive tile enables real SGR button reports");
        assert.ok(!modes.has(1003), "The tile does not opt into hover or drag reporting");
        const lines = tui.getDebugPaint()!.lines;
        assert.equal(lines.length, terminal.rows, "The real host composes overlays into a physical screen-sized window");
        assert.ok(lines[0].includes("255;231;128"), "The visible tile is paper-yellow under text and SIXEL protocols");
        assert.equal(visibleWidth(tile.render(3)[0]), 3);
        assert.ok(!tile.render(3)[0].includes("\x1bP"), "The tile always uses ANSI cells, never SIXEL escape payloads");

        for (const input of ["q", "\x03", "\x1b[27;7;100~", click(74), click(78), click(75, 1), click(75, 0, 64), click(75, 0, 2), click(75, 0, 32), click(75, 0, 0, "m")]) {
          const before = observed.length;
          tui.injectDebugInput(input);
          assert.equal(observed.length, before + 1, "Unrelated keys, outside clicks, releases, wheel and motion retain host routing");
          assert.equal(delivered.at(-1), input);
          assert.equal(restored, 0);
        }
        const beforeHit = observed.length;
        tui.injectDebugInput(click(75));
        assert.equal(restored, 1, "A genuine tile press restores even though its overlay is released");
        assert.equal(observed.length, beforeHit, "Only the tile's own left press is intercepted");
        assert.equal(tui.getFocused(), editor);

        const dialog = tui.showOverlay(modal, { width: 20, anchor: "center" });
        tui.renderNow();
        assert.ok(!tui.getDebugPaint()!.lines.some(line => line.includes("255;231;128")), "A foreign overlay suppresses the tile, not just its click target");
        assert.ok(!modes.has(1000) && !modes.has(1006), "An ordinary dialog releases tile-owned reporting");
        tui.injectDebugInput(click(75));
        assert.equal(restored, 1);
        assert.equal(delivered.at(-1), `modal:${click(75)}`);
        dialog.hide();
        tui.renderNow();
        assert.ok(modes.has(1000) && modes.has(1006), "Closing the dialog re-enables the visible tile");
        assert.equal(tui.getFocused(), editor);

        const fullscreen = tui.showOverlay(modal, { width: "100%", maxHeight: "100%", fullscreen: true });
        tui.renderNow();
        assert.equal(tui.getDebugPaint()!.altScreen, true);
        assert.ok(modes.has(1000) && modes.has(1003) && modes.has(1006), "Suppression preserves the host fullscreen modal's mouse modes");
        tui.injectDebugInput(click(75));
        assert.equal(restored, 1, "Alternate-buffer clicks cannot restore a hidden tile");
        fullscreen.hide();
        tui.renderNow();
        assert.equal(tui.getDebugPaint()!.altScreen, false);
        assert.ok(modes.has(1000) && modes.has(1006) && !modes.has(1003));

        tui.setFocus(modal);
        tui.renderNow();
        assert.ok(tui.getDebugPaint()!.lines.some(line => line.includes("255;231;128")), "A released tile remains available across nonmodal host focus changes");
        assert.ok(modes.has(1000) && modes.has(1006));
        tui.setFocus(editor);
        tui.renderNow();

        // A resize must not use the last paint's hit box before a new paint.
        Object.defineProperty(terminal, "columns", { value: 100, configurable: true });
        tui.injectDebugInput(click(75));
        assert.equal(restored, 1, "A stale pre-resize click box is rejected");
        tui.renderNow();
        tui.injectDebugInput(click(95));
        assert.equal(restored, 2, "The tile follows the owning viewport's new top-right corner");

        tile.deactivate();
        assert.match(writes.at(-1) ?? "", /\x1b\[\?1000l\x1b\[\?1006l/);
        handle!.hide();
        handle = undefined;
        tui.renderNow();
        assert.ok(modes.has(1000) && modes.has(1003) && modes.has(1006), "Removing the tile restores the host's unchanged inline tracking provider");
        tui.injectDebugInput(click(95));
        assert.equal(restored, 2, "Expanded/hidden notes retain no tile input listener");

        mount();
        tile.dispose();
        assert.ok(!modes.has(1000) && !modes.has(1006), "Disposal releases tile-owned modes immediately");
        tui.injectDebugInput(click(95));
        assert.equal(restored, 2);
      } finally {
        tile.dispose();
        handle?.hide();
        tui.stop();
      }
    }
  } finally {
    setTerminalImageProtocol(previousProtocol);
  }
  pi.on("session_start", (_event, ctx) => ctx.shutdown());
}
