import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import { getCellDimensions, getImageDimensions, Image, TERMINAL, truncateToWidth, visibleWidth, type Component, type TUI } from "@oh-my-pi/pi-tui";
import { continuesAnimation, effectLabels, semanticFrameKey, visualFrameKey } from "./art.ts";
import type { VisualFrame } from "./effects.ts";
import { PAPER_WIDTH, paperSvg, WELCOME, wrapLabel, type PaperShape } from "./paper.ts";
import { cleanLabel, type Note } from "./state.ts";
import { NotePointer, type PaperSurface } from "./pointer.ts";

/** Test cell centers against the opaque SVG body, not its padded image rectangle. */
function graphicPaperHit(shape: PaperShape, scale: number, cell: RasterRequest["cell"]): PaperSurface["contains"] {
  const transforms = [...shape.transform.matchAll(/(rotate|translate)\(([^)]+)\)/g)].map(match => ({
    kind: match[1], values: match[2].trim().split(/[ ,]+/).map(Number),
  }));
  return (col, row) => {
    if (!shape.visible) return false;
    let x = (col + 0.5) * cell.widthPx / scale - shape.x;
    let y = (row + 0.5) * cell.heightPx / scale - shape.y;
    // SVG transform lists compose right-to-left, so their inverses apply in
    // source order. Crumple's changing scale is deliberately noninteractive.
    for (const { kind, values } of transforms) {
      if (kind === "translate") { x -= values[0]; y -= values[1] ?? 0; }
      else {
        const angle = -values[0] * Math.PI / 180;
        const cx = values[1] ?? 0;
        const cy = values[2] ?? 0;
        const dx = x - cx;
        const dy = y - cy;
        x = cx + dx * Math.cos(angle) - dy * Math.sin(angle);
        y = cy + dx * Math.sin(angle) + dy * Math.cos(angle);
      }
    }
    x -= 8;
    y -= 5;
    if (x < 0 || y < 0 || x >= shape.width || y >= shape.height) return false;
    const dx = Math.max(13 - x, x - (shape.width - 13), 0);
    const dy = Math.max(13 - y, y - (shape.height - 13), 0);
    return dx * dx + dy * dy <= 13 * 13;
  };
}

// Deliberately independent of the host theme: sticky-paper yellow, dark ink.
const PAPER = "\x1b[48;2;255;231;128m\x1b[38;2;41;38;22m";
const SHADOW = "\x1b[48;2;34;33;27m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const NORMAL = "\x1b[22m";

interface StickyNoteOptions {
  requestRender?: () => void;
  maxRows?: () => number;
  onError?: (error: unknown) => void;
}

interface RasterRequest {
  key: string;
  scene: string;
  note: Note;
  fx?: VisualFrame;
  width: number;
  maxRows: number;
  widthPx: number;
  heightPx: number;
  cell: { widthPx: number; heightPx: number };
}

export class StickyNote implements Component {
  debugId = "omp-stickynote";
  #note: Note = { title: "Ready to begin", tasks: [] };
  #fx?: VisualFrame;
  #fxKey = "";
  #semanticKey = "";
  #options: StickyNoteOptions;
  #revision = 0;
  #scene = 0;
  #width = -1;
  #maxRows = -1;
  #rows: readonly string[] = [];
  #desired?: RasterRequest;
  #running = false;
  #image?: Image;
  #imageKey?: string;
  #imageScene?: string;
  #failedKey?: string;
  #disposed = false;
  #graphicsRows?: readonly string[];
  #graphicsProtocol: typeof TERMINAL.imageProtocol = null;
  #placeholderRows: readonly string[] = [];
  #placeholderWidth = -1;
  #pointer: NotePointer;
  #onMinimize?: () => void;
  #surface?: PaperSurface;
  #fallbackSurface?: PaperSurface;
  #imageHit?: PaperSurface["contains"];

  constructor(options: StickyNoteOptions = {}) {
    this.#options = options;
    this.#pointer = new NotePointer(this, () => this.#surface, true, () => this.#onMinimize?.());
  }

  /** Image-owned control rows for the host's post-paint adapter, never overlay composition. */
  get graphicsRows(): readonly string[] | undefined {
    return !this.#disposed && this.#graphicsProtocol === TERMINAL.imageProtocol ? this.#graphicsRows : undefined;
  }

  /** Activate only after mounting a released overlay and restoring editor focus. */
  activate(tui: TUI, onMinimize: () => void): void {
    if (this.#disposed) return;
    this.#onMinimize = onMinimize;
    this.#pointer.activate(tui);
  }

  /** Release pointer reporting before hiding or replacing the paper overlay. */
  deactivate(): void {
    this.#pointer.deactivate();
    this.#surface = undefined;
    this.#onMinimize = undefined;
  }

  update(note: Note, fx?: VisualFrame): void {
    if (this.#disposed) return;
    const next = { title: cleanLabel(note.title), tasks: note.tasks.slice(0, 3).map(task => ({ text: cleanLabel(task.text), done: task.done })) };
    const fxKey = fx === this.#fx ? this.#fxKey : visualFrameKey(fx);
    const semanticKey = fx === this.#fx ? this.#semanticKey : semanticFrameKey(fx);
    const sameNote = next.title === this.#note.title && next.tasks.length === this.#note.tasks.length &&
      next.tasks.every((task, i) => task.text === this.#note.tasks[i].text && task.done === this.#note.tasks[i].done);
    const changed = !sameNote || (TERMINAL.imageProtocol ? fxKey !== this.#fxKey : semanticKey !== this.#semanticKey);
    if (changed && (!sameNote || !continuesAnimation(this.#fx, fx))) {
      this.#scene++;
      this.#desired = undefined;
    }
    this.#fx = fx;
    this.#fxKey = fxKey;
    this.#semanticKey = semanticKey;
    if (!changed) return;
    // Keep our own snapshot: asynchronous raster work must not observe caller mutations.
    this.#note = next;
    this.#revision++;
    this.#width = -1;
    this.#graphicsRows = undefined;
  }

  invalidate(): void {
    this.#width = -1;
    this.#graphicsRows = undefined;
    this.#image?.invalidate();
  }

  releaseRenderCaches(): void {
    this.#rows = [];
    // Hiding and showing a note must not rasterize or encode it again.
    this.invalidate();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.deactivate();
    this.#desired = undefined;
    this.#image?.release();
    this.#image = undefined;
    this.#imageKey = undefined;
    this.#rows = [];
    this.#graphicsRows = undefined;
    this.#placeholderRows = [];
  }

  #report(error: unknown): void {
    try {
      if (this.#options.onError) this.#options.onError(error);
      else console.error("Sticky note graphics unavailable:", error);
    } catch (reportError) {
      console.error("Sticky note error reporter failed:", reportError);
    }
  }

  #requestRender(): void {
    if (this.#disposed) return;
    try {
      this.#options.requestRender?.();
    } catch (error) {
      this.#report(error);
    }
  }

  #fail(error: unknown, key: string): void {
    if (this.#disposed || (this.#desired?.key !== key && this.#imageKey !== key) || this.#failedKey === key) return;
    this.#failedKey = key;
    this.#image?.release();
    this.#image = undefined;
    this.#imageKey = undefined;
    this.#graphicsRows = undefined;
    this.#report(error);
    if (this.#desired && this.#desired.key !== key) this.#requestRender();
  }

  async #rasterize(): Promise<void> {
    const request = this.#desired;
    if (this.#disposed || this.#running || !request || this.#failedKey === request.key || this.#imageKey === request.key) return;
    this.#running = true;
    try {
      const canvasWidth = Math.max(PAPER_WIDTH, (request.width - 2) * 10);
      const paper = paperSvg(request.note, request.cell.heightPx * canvasWidth / request.widthPx, canvasWidth, request.fx);
      // Permit HiDPI upscaling and pad to whole terminal cells, as the host's SvgFigure does.
      const scale = Math.max(1, request.widthPx / paper.width, request.heightPx / paper.height);
      const png = await rasterizeSvg(new TextEncoder().encode(paper.svg), request.widthPx, request.heightPx, scale, request.cell);
      if (this.#disposed || this.#desired?.scene !== request.scene) return;
      const base64 = Buffer.from(png).toString("base64");
      const dimensions = getImageDimensions(base64, "image/png");
      if (!dimensions) throw new Error("Sticky note rasterizer returned an invalid PNG");
      const image = new Image(base64, "image/png", {
        // Image's SIXEL encoder reports failure through its fallback rather than rejecting.
        fallbackColor: () => {
          this.#fail(new Error("The terminal could not encode the sticky note image"), request.key);
          return "";
        },
      }, {
        maxWidthCells: Math.max(1, request.width - 2),
        maxHeightCells: request.maxRows,
        requestRender: () => {
          if (!this.#disposed && this.#image === image && this.#desired?.scene === request.scene) this.#requestRender();
        },
      }, dimensions);
      this.#image?.release();
      this.#image = image;
      this.#imageKey = request.key;
      this.#imageHit = graphicPaperHit(paper.paper, Math.min(scale, request.widthPx / paper.width, request.heightPx / paper.height), request.cell);
      this.#imageScene = request.scene;
      this.#requestRender();
    } catch (error) {
      this.#fail(error, request.key);
    } finally {
      this.#running = false;
      // Once a compatible image exists, render() gives its encoder a chance to
      // present it before requesting the latest pose.
      if (!this.#disposed && !this.#image && this.#desired && this.#desired !== request) void this.#rasterize();
    }
  }

  render(width: number): readonly string[] {
    if (this.#disposed) return [];
    this.#surface = undefined;
    this.#graphicsRows = undefined;
    width = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
    this.#pointer.rendered(width);
    const availableRows = this.#options.maxRows?.() ?? process.stdout.rows ?? 40;
    const maxRows = Number.isFinite(availableRows) ? Math.max(1, Math.floor(availableRows)) : 40;
    if (TERMINAL.imageProtocol) {
      const cell = getCellDimensions();
      const geometry = `${width}/${maxRows}/${cell.widthPx}/${cell.heightPx}/${TERMINAL.imageProtocol}`;
      const key = `${this.#revision}/${geometry}`;
      if (this.#desired?.key !== key) {
        const scene = `${this.#scene}/${geometry}`;
        if (this.#imageScene !== scene) {
          this.#image?.release();
          this.#image = undefined;
          this.#imageKey = undefined;
        }
        this.#desired = {
          key, scene, note: this.#note, fx: this.#fx, width, maxRows,
          widthPx: Math.max(1, Math.floor(Math.max(1, width - 2) * cell.widthPx)),
          heightPx: Math.max(1, Math.floor(maxRows * cell.heightPx)),
          cell: { widthPx: cell.widthPx, heightPx: cell.heightPx },
        };
      }
      if (!this.#image && !this.#running && this.#failedKey !== key) void this.#rasterize();
      if (this.#image) {
        try {
          const lines = this.#image.render(width);
          // The compositor slices DCS strings. It receives only an opaque, width-safe rectangle;
          // the host emits these cached Image rows after painting that rectangle.
          if (lines.length <= maxRows && lines.some(line => TERMINAL.isImageLine(line))) {
            this.#graphicsRows = lines;
            if (this.#imageKey !== key && !this.#running && this.#failedKey !== key) void this.#rasterize();
            this.#graphicsProtocol = TERMINAL.imageProtocol;
            this.#surface = { width, height: lines.length, contains: this.#imageHit! };
            if (this.#placeholderWidth !== width || this.#placeholderRows.length !== lines.length) {
              this.#placeholderWidth = width;
              this.#placeholderRows = Array<string>(lines.length).fill(" ".repeat(width));
            }
            return this.#placeholderRows;
          }
        } catch (error) {
          this.#fail(error, key);
        }
      }
    } else if (this.#desired) {
      this.#desired = undefined;
      this.#image?.release();
      this.#image = undefined;
      this.#imageKey = undefined;
    }
    return this.#fallback(width, maxRows);
  }

  #fallback(width: number, maxRows: number): readonly string[] {
    if (width === this.#width && maxRows === this.#maxRows) {
      this.#surface = this.#fallbackSurface;
      return this.#rows;
    }
    const shadow = width >= 8 ? 1 : 0;
    const cardWidth = width - shadow;
    const padding = cardWidth >= 8 ? 2 : 0;
    const inner = Math.max(1, cardWidth - padding * 2);
    const row = (text: string, bold = false, paper = PAPER) => {
      const fitted = truncateToWidth(text, inner);
      return paper + " ".repeat(padding) + (bold ? BOLD : "") + fitted + NORMAL +
        " ".repeat(Math.max(0, cardWidth - padding - visibleWidth(fitted))) + RESET +
        (shadow ? SHADOW + " " + RESET : "");
    };
    const edge = (top: boolean) => cardWidth >= 4
      ? PAPER + (top ? "╭" : "╰") + "─".repeat(cardWidth - 2) + (top ? "╮" : "╯") + RESET + " ".repeat(shadow)
      : row("");
    const rows = [edge(true)];
    const labels = effectLabels(this.#fx);
    const handoff = this.#fx?.fun && !this.#fx.dnd && this.#fx.motion !== "crumple" &&
      (this.#fx.attention === "waiting" || this.#fx.motion === "turnDone" || this.#fx.motion === "victory");
    if (handoff) {
      const sign = this.#fx?.attention === "waiting" ? "\x1b[48;2;116;50;23m\x1b[38;2;255;246;220m" : PAPER;
      for (const line of wrapLabel(labels[0], 2, inner)) {
        rows.push(row(" ".repeat(Math.max(0, Math.floor((inner - visibleWidth(line)) / 2))) + line, true, sign));
      }
    }
    for (const line of wrapLabel(this.#note.title.toUpperCase(), 2, inner)) {
      rows.push(row(" ".repeat(Math.max(0, Math.floor((inner - visibleWidth(line)) / 2))) + line, true));
    }
    rows.push(row(""));
    if (this.#note.tasks.length === 0) {
      for (const line of wrapLabel(WELCOME, 2, inner)) rows.push(row(line));
    }
    for (const [index, task] of this.#note.tasks.entries()) {
      if (index > 0) rows.push(row(""));
      const lines = wrapLabel(task.text, 2, Math.max(1, inner - 4));
      for (let i = 0; i < lines.length; i++) {
        rows.push(row((i === 0 ? (task.done ? "[x] " : "[ ] ") : "    ") + lines[i], true));
      }
    }
    for (let i = handoff ? 1 : 0; i < labels.length; i++) {
      rows.push(row(""));
      for (const line of wrapLabel(labels[i], 2, inner)) rows.push(row(line, true));
    }
    rows.push(row(""), edge(false));
    if (shadow) rows.push(" " + SHADOW + " ".repeat(cardWidth) + RESET);
    this.#width = width;
    this.#maxRows = maxRows;
    this.#rows = rows.length > maxRows ? rows.slice(0, maxRows) : rows;
    const paperRows = Math.min(this.#rows.length, rows.length - shadow);
    this.#surface = { width, height: this.#rows.length, contains: (col, row) => col < cardWidth && row < paperRows };
    this.#fallbackSurface = this.#surface;
    return this.#rows;
  }
}
