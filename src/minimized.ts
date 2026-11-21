import type { Component, OverlayOptions, TUI } from "@oh-my-pi/pi-tui";
import { NotePointer, type PaperSurface } from "./pointer.ts";

const PAPER = "\x1b[48;2;255;231;128m\x1b[38;2;41;38;22m";
const RESET = "\x1b[0m";
const WIDTH = 3;
const RIGHT = 2;
const EMPTY: readonly string[] = [];
const ROWS = [1, 2, 3].map(width => [PAPER + (width === 1 ? "+" : width === 2 ? "+ " : " + ") + RESET]);

interface MinimizedNoteOptions {
  onRestore: () => void;
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
  #pointer: NotePointer;
  #surface?: PaperSurface;
  #disposed = false;

  constructor(options: MinimizedNoteOptions) {
    this.#pointer = new NotePointer(this, () => this.#surface, false, options.onRestore);
  }

  /** The caller releases the overlay and restores editor focus before this. */
  activate(tui: TUI): void {
    if (!this.#disposed) this.#pointer.activate(tui);
  }

  /** Call BEFORE hiding/removing its overlay, so the host can restore its modes. */
  deactivate(): void {
    this.#surface = undefined;
    this.#pointer.deactivate();
  }

  dispose(): void {
    this.deactivate();
    this.#disposed = true;
  }

  render(width: number): readonly string[] {
    const renderedWidth = !this.#disposed && this.#pointer.visible() ? Math.max(1, Math.min(WIDTH, Math.floor(width))) : 0;
    this.#surface = renderedWidth ? { width: renderedWidth, height: 1, contains: () => true } : undefined;
    this.#pointer.rendered(renderedWidth);
    return renderedWidth ? ROWS[renderedWidth - 1] : EMPTY;
  }

  #overlayVisible(): boolean {
    return !this.#disposed && this.#pointer.visible();
  }
}
