import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import { getCellDimensions, getImageDimensions, Image, TERMINAL, truncateToWidth, visibleWidth, type Component } from "@oh-my-pi/pi-tui";
import { paperSvg, WELCOME, wrapLabel } from "./paper.ts";
import { cleanLabel, type Note } from "./state.ts";

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
  note: Note;
  width: number;
  maxRows: number;
  widthPx: number;
  heightPx: number;
  cell: { widthPx: number; heightPx: number };
}

export class StickyNote implements Component {
  debugId = "omp-stickynote";
  #note: Note = { title: "Ready to begin", tasks: [] };
  #options: StickyNoteOptions;
  #revision = 0;
  #width = -1;
  #maxRows = -1;
  #rows: readonly string[] = [];
  #desired?: RasterRequest;
  #running = false;
  #image?: Image;
  #imageKey?: string;
  #failedKey?: string;
  #disposed = false;
  #graphicsRows?: readonly string[];
  #graphicsProtocol: typeof TERMINAL.imageProtocol = null;
  #placeholderRows: readonly string[] = [];
  #placeholderWidth = -1;

  constructor(options: StickyNoteOptions = {}) {
    this.#options = options;
  }

  /** Image-owned control rows for the host's post-paint adapter, never overlay composition. */
  get graphicsRows(): readonly string[] | undefined {
    return !this.#disposed && this.#graphicsProtocol === TERMINAL.imageProtocol ? this.#graphicsRows : undefined;
  }

  update(note: Note): void {
    if (this.#disposed) return;
    const next = { title: cleanLabel(note.title), tasks: note.tasks.slice(0, 3).map(task => ({ text: cleanLabel(task.text), done: task.done })) };
    if (next.title === this.#note.title && next.tasks.length === this.#note.tasks.length &&
        next.tasks.every((task, i) => task.text === this.#note.tasks[i].text && task.done === this.#note.tasks[i].done)) return;
    // Keep our own snapshot: asynchronous raster work must not observe caller mutations.
    this.#note = next;
    this.#revision++;
    this.#desired = undefined;
    this.#image?.release();
    this.#image = undefined;
    this.#imageKey = undefined;
    this.invalidate();
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
    if (this.#disposed || this.#desired?.key !== key || this.#failedKey === key) return;
    this.#failedKey = key;
    this.#image?.release();
    this.#image = undefined;
    this.#imageKey = undefined;
    this.#graphicsRows = undefined;
    this.#report(error);
  }

  async #rasterize(): Promise<void> {
    const request = this.#desired;
    if (this.#disposed || this.#running || !request || this.#failedKey === request.key || this.#imageKey === request.key) return;
    this.#running = true;
    try {
      const paper = paperSvg(request.note);
      // Permit HiDPI upscaling and pad to whole terminal cells, as the host's SvgFigure does.
      const scale = Math.max(1, request.widthPx / paper.width, request.heightPx / paper.height);
      const png = await rasterizeSvg(new TextEncoder().encode(paper.svg), request.widthPx, request.heightPx, scale, request.cell);
      if (this.#disposed || this.#desired !== request) return;
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
          if (!this.#disposed && this.#image === image && this.#desired === request) this.#requestRender();
        },
      }, dimensions);
      this.#image = image;
      this.#imageKey = request.key;
      this.#requestRender();
    } catch (error) {
      this.#fail(error, request.key);
    } finally {
      this.#running = false;
      // Exactly one native operation at a time; superseded requests never repaint.
      if (!this.#disposed && this.#desired && this.#desired !== request) void this.#rasterize();
    }
  }

  render(width: number): readonly string[] {
    if (this.#disposed) return [];
    this.#graphicsRows = undefined;
    width = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
    const availableRows = this.#options.maxRows?.() ?? process.stdout.rows ?? 40;
    const maxRows = Number.isFinite(availableRows) ? Math.max(1, Math.floor(availableRows)) : 40;
    if (TERMINAL.imageProtocol) {
      const cell = getCellDimensions();
      const key = `${this.#revision}/${width}/${maxRows}/${cell.widthPx}/${cell.heightPx}/${TERMINAL.imageProtocol}`;
      if (this.#desired?.key !== key) {
        this.#image?.release();
        this.#image = undefined;
        this.#imageKey = undefined;
        this.#desired = {
          key, note: this.#note, width, maxRows,
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
            this.#graphicsProtocol = TERMINAL.imageProtocol;
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
    if (width === this.#width && maxRows === this.#maxRows) return this.#rows;
    const shadow = width >= 8 ? 1 : 0;
    const cardWidth = width - shadow;
    const padding = cardWidth >= 8 ? 2 : 0;
    const inner = Math.max(1, cardWidth - padding * 2);
    const row = (text: string, bold = false) => {
      const fitted = truncateToWidth(text, inner);
      return PAPER + " ".repeat(padding) + (bold ? BOLD : "") + fitted + NORMAL +
        " ".repeat(Math.max(0, cardWidth - padding - visibleWidth(fitted))) + RESET +
        (shadow ? SHADOW + " " + RESET : "");
    };
    const edge = (top: boolean) => cardWidth >= 4
      ? PAPER + (top ? "╭" : "╰") + "─".repeat(cardWidth - 2) + (top ? "╮" : "╯") + RESET + " ".repeat(shadow)
      : row("");
    const rows = [edge(true)];
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
    rows.push(row(""), edge(false));
    if (shadow) rows.push(" " + SHADOW + " ".repeat(cardWidth) + RESET);
    this.#width = width;
    this.#maxRows = maxRows;
    this.#rows = rows.length > maxRows ? rows.slice(0, maxRows) : rows;
    return this.#rows;
  }
}
