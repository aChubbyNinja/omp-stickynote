import { parseSgrMouse, type Component, type TUI, type TuiPaint } from "@oh-my-pi/pi-tui";

const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1002l\x1b[?1000l\x1b[?1006l";
const DOUBLE_CLICK_MS = 400;
const owners = new WeakMap<TUI, NotePointer>();

export interface PaperSurface {
  width: number;
  height: number;
  contains: (col: number, row: number) => boolean;
}

interface PaintedSurface {
  col: number;
  row: number;
  columns: number;
  rows: number;
  surface: PaperSurface;
  placement: string;
}

/** One mouse-mode/input owner shared by the expanded paper and restore tile. */
export class NotePointer {
  #component: Component;
  #surface: () => PaperSurface | undefined;
  #double: boolean;
  #action: () => void;
  #tui?: TUI;
  #removeInput?: () => void;
  #removePaint?: () => void;
  #painted?: PaintedSurface;
  #renderedPlacement?: string;
  #tracking = false;
  #press?: { col: number; row: number; time: number };
  #click?: { col: number; row: number; time: number };

  constructor(component: Component, surface: () => PaperSurface | undefined, double: boolean, action: () => void) {
    this.#component = component;
    this.#surface = surface;
    this.#double = double;
    this.#action = action;
  }

  activate(tui: TUI): void {
    if (this.#tui === tui) return;
    this.deactivate();
    owners.get(tui)?.deactivate();
    owners.set(tui, this);
    this.#tui = tui;
    this.#removeInput = tui.addInputListener(data => this.#input(data), { prepend: true });
    this.#removePaint = tui.addPaintListener(frame => this.#paint(frame));
    tui.requestRender(true);
  }

  deactivate(): void {
    this.#reset();
    this.#painted = undefined;
    this.#removeInput?.();
    this.#removeInput = undefined;
    this.#removePaint?.();
    this.#removePaint = undefined;
    this.#releaseTracking();
    if (this.#tui && owners.get(this.#tui) === this) owners.delete(this.#tui);
    this.#tui = undefined;
  }

  foreignOverlay(): TUI["overlayStack"][number] | undefined {
    const tui = this.#tui;
    if (!tui) return undefined;
    for (let i = tui.overlayStack.length - 1; i >= 0; i--) {
      const entry = tui.overlayStack[i];
      if (entry.component !== this.#component && !entry.hidden && entry.options?.visible?.(tui.terminal.columns, tui.terminal.rows) !== false) return entry;
    }
    return undefined;
  }

  visible(): boolean {
    return !!this.#tui && !this.foreignOverlay();
  }

  /** Capture placement during composition, before post-paint listeners may move it. */
  rendered(width: number): void {
    const tui = this.#tui;
    this.#renderedPlacement = tui ? this.#placement(tui.terminal.columns, width)?.key : undefined;
  }

  #canInteract(): boolean {
    const tui = this.#tui;
    const entry = tui?.overlayStack.find(entry => entry.component === this.#component);
    return !!tui && !!entry && !entry.hidden && entry.released &&
      entry.options?.visible?.(tui.terminal.columns, tui.terminal.rows) !== false && !this.foreignOverlay();
  }

  #placement(columns: number, width: number): { col: number; row: number; key: string } | undefined {
    const options = this.#tui?.overlayStack.find(entry => entry.component === this.#component)?.options;
    // Sticky surfaces use these two top anchors only. Fail closed rather than
    // inventing coordinates if another caller changes their placement policy.
    if (options?.anchor !== "top-right" && options?.anchor !== "top-center") return undefined;
    if (options.row !== undefined || options.col !== undefined || options.offsetX || options.offsetY) return undefined;
    const margin = typeof options.margin === "number"
      ? { top: options.margin, right: options.margin, bottom: options.margin, left: options.margin }
      : options.margin;
    const left = Math.max(0, margin?.left ?? 0);
    const right = Math.max(0, margin?.right ?? 0);
    const top = Math.max(0, margin?.top ?? 0);
    const bottom = Math.max(0, margin?.bottom ?? 0);
    const available = Math.max(1, columns - left - right);
    const col = options.anchor === "top-center" ? left + Math.floor((available - width) / 2) : left + available - width;
    const key = `${options.anchor}/${options.width}/${options.maxHeight}/${left}/${right}/${top}/${bottom}/${width}`;
    return { col: Math.max(left, col), row: top, key };
  }

  #paint(frame: TuiPaint): void {
    const tui = this.#tui;
    const surface = this.#surface();
    const position = surface && this.#placement(frame.columns, surface.width);
    if (!tui || frame.alt || frame.viewport.length < frame.rows || !this.#canInteract() || !surface || !position || position.key !== this.#renderedPlacement) {
      this.#painted = undefined;
      this.#reset();
      this.#releaseTracking();
      return;
    }
    if (this.#painted && (this.#painted.placement !== position.key || this.#painted.columns !== frame.columns || this.#painted.rows !== frame.rows || this.#painted.surface.height !== surface.height)) this.#reset();
    this.#painted = { col: position.col, row: position.row, placement: position.key, columns: frame.columns, rows: frame.rows, surface };
    if (!this.#tracking) {
      // Ordinary overlays disable the host's inline provider. Expanded paper
      // needs button-motion reports to reject drags, but never hover capture.
      tui.terminal.write(MOUSE_ON + (this.#double ? "\x1b[?1002h" : ""));
      this.#tracking = true;
    }
  }

  #input(data: string): { consume: true } | undefined {
    if (!data.startsWith("\x1b[<")) { this.#reset(); return undefined; }
    const tui = this.#tui;
    const painted = this.#painted;
    const event = parseSgrMouse(data);
    if (!tui || !painted || !event || !this.#canInteract() || painted.columns !== tui.terminal.columns || painted.rows !== tui.terminal.rows ||
        this.#placement(painted.columns, painted.surface.width)?.key !== painted.placement) {
      this.#reset();
      return undefined;
    }
    const col = event.col - painted.col;
    const row = event.row - painted.row;
    const hit = col >= 0 && row >= 0 && col < painted.surface.width && row < painted.surface.height && painted.surface.contains(col, row);
    if (!this.#double) {
      if (!hit || !event.leftClick) return undefined;
      this.#painted = undefined;
      this.#action();
      return { consume: true };
    }
    if (!hit || event.button !== 0 || event.motion || event.wheel !== null) {
      this.#reset();
      return undefined;
    }
    const now = performance.now();
    if (!event.release) {
      if (this.#press) this.#click = undefined;
      this.#press = { col, row, time: now };
      return { consume: true };
    }
    const press = this.#press;
    this.#press = undefined;
    if (!press || press.col !== col || press.row !== row || now - press.time > DOUBLE_CLICK_MS) {
      this.#click = undefined;
      return undefined;
    }
    const previous = this.#click;
    if (previous && previous.col === col && previous.row === row && now - previous.time <= DOUBLE_CLICK_MS) {
      this.#reset();
      this.#painted = undefined;
      this.#action();
    } else {
      this.#click = { col, row, time: now };
    }
    return { consume: true };
  }

  #reset(): void {
    this.#press = undefined;
    this.#click = undefined;
  }

  #releaseTracking(): void {
    if (!this.#tracking) return;
    this.#tracking = false;
    const foreign = this.foreignOverlay();
    if (foreign?.options?.fullscreen && foreign.options.mouseTracking !== false) return;
    this.#tui?.terminal.write(MOUSE_OFF);
  }
}
