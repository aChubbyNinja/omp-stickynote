import { parseSgrMouse, type Component, type OverlayOptions, type TUI, type TuiPaint } from "@oh-my-pi/pi-tui";

const PAPER = "\x1b[48;2;255;231;128m\x1b[38;2;41;38;22m";
const RESET = "\x1b[0m";
// Button events only: unlike the host's full mouse mode, no hover/drag capture.
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";
const WIDTH = 3;
const RIGHT = 2;
const EMPTY: readonly string[] = [];
const ROWS = [1, 2, 3].map(width => [PAPER + (width === 1 ? "+" : width === 2 ? "+ " : " + ") + RESET]);

interface MinimizedNoteOptions {
  onRestore: () => void;
}

interface HitBox {
  col: number;
  width: number;
  columns: number;
  rows: number;
}

/** A passive ANSI tile; activate only after mounting it with overlayOptions. */
export class MinimizedNote implements Component {
  debugId = "omp-stickynote.minimized";
  readonly overlayOptions: OverlayOptions = {
    anchor: "top-right",
    width: WIDTH,
    maxHeight: 1,
    margin: { top: 0, right: RIGHT, left: 0, bottom: 0 },
    visible: () => this.#overlayVisible(),
  };
  #onRestore: () => void;
  #tui?: TUI;
  #removeInput?: () => void;
  #removePaint?: () => void;
  #hit?: HitBox;
  #renderedWidth = 0;
  #tracking = false;
  #disposed = false;

  constructor(options: MinimizedNoteOptions) {
    this.#onRestore = options.onRestore;
  }

  /** The caller releases the overlay and restores editor focus before this. */
  activate(tui: TUI): void {
    if (this.#disposed || this.#tui === tui) return;
    this.deactivate();
    this.#tui = tui;
    this.#removeInput = tui.addInputListener(data => {
      if (!data.startsWith("\x1b[<")) return undefined;
      const hit = this.#hit;
      if (!hit || !this.#canInteract() || hit.columns !== tui.terminal.columns || hit.rows !== tui.terminal.rows) return undefined;
      const event = parseSgrMouse(data);
      if (!event?.leftClick || event.row !== 0 || event.col < hit.col || event.col >= hit.col + hit.width) return undefined;
      // Only this tile's press is consumed. Unrelated mouse reports and every
      // keystroke retain the host's original listener/focus routing.
      this.#hit = undefined;
      this.#onRestore();
      return { consume: true };
    }, { prepend: true });
    this.#removePaint = tui.addPaintListener(frame => this.#paint(frame));
    tui.requestRender(true);
  }

  /** Call BEFORE hiding/removing its overlay, so the host can restore its modes. */
  deactivate(): void {
    this.#hit = undefined;
    this.#renderedWidth = 0;
    this.#removeInput?.();
    this.#removeInput = undefined;
    this.#removePaint?.();
    this.#removePaint = undefined;
    this.#releaseTracking();
    this.#tui = undefined;
  }

  dispose(): void {
    this.deactivate();
    this.#disposed = true;
  }

  render(width: number): readonly string[] {
    this.#renderedWidth = this.#canInteract() ? Math.max(1, Math.min(WIDTH, Math.floor(width))) : 0;
    return this.#renderedWidth ? ROWS[this.#renderedWidth - 1] : EMPTY;
  }

  #foreignOverlay(): TUI["overlayStack"][number] | undefined {
    const tui = this.#tui;
    if (!tui) return undefined;
    for (let i = tui.overlayStack.length - 1; i >= 0; i--) {
      const entry = tui.overlayStack[i];
      if (entry.component !== this && !entry.hidden && entry.options?.visible?.(tui.terminal.columns, tui.terminal.rows) !== false) return entry;
    }
    return undefined;
  }

  #overlayVisible(): boolean {
    const tui = this.#tui;
    return !!tui && !this.#disposed && !this.#foreignOverlay();
  }

  #canInteract(): boolean {
    const tui = this.#tui;
    if (!tui || !this.#overlayVisible()) return false;
    const entry = tui.overlayStack.find(item => item.component === this);
    return !!entry && !entry.hidden && entry.released;
  }

  #paint(frame: TuiPaint): void {
    const tui = this.#tui;
    if (!tui) return;
    if (frame.alt || !this.#canInteract() || !this.#renderedWidth || frame.viewport.length < frame.rows) {
      this.#hit = undefined;
      this.#releaseTracking();
      return;
    }
    // Both 18.21 and 19 compose ordinary overlays into a full-height physical
    // screen window, not document/scrollback coordinates. Top-right is row 0.
    this.#hit = {
      col: Math.max(0, frame.columns - RIGHT - this.#renderedWidth),
      width: this.#renderedWidth,
      columns: frame.columns,
      rows: frame.rows,
    };
    if (!this.#tracking) {
      // The host disables its own inline tracking for ANY ordinary overlay,
      // including released ones. Do not replace its singleton inline provider.
      tui.terminal.write(MOUSE_ON);
      this.#tracking = true;
    }
  }

  #releaseTracking(): void {
    if (!this.#tracking) return;
    this.#tracking = false;
    const foreign = this.#foreignOverlay();
    // A fullscreen modal already owns host mouse reporting. Never disable its
    // modes while dropping our normal-buffer ownership.
    if (foreign?.options?.fullscreen && foreign.options.mouseTracking !== false) return;
    this.#tui?.terminal.write(MOUSE_OFF);
  }
}
