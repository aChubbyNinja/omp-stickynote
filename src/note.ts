import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@oh-my-pi/pi-tui";
import { cleanLabel, type Note } from "./state.ts";

// Deliberately independent of the host theme: sticky-paper yellow, dark ink.
const PAPER = "\x1b[48;2;255;231;106m\x1b[38;2;35;31;16m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const NORMAL = "\x1b[22m";

export class StickyNote implements Component {
  debugId = "omp-stickynote";
  #note: Note = { title: "Project", tasks: [] };
  #width = -1;
  #rows: readonly string[] = [];

  update(note: Note): void {
    if (note.title === this.#note.title && note.tasks.length === this.#note.tasks.length &&
        note.tasks.every((task, i) => task.text === this.#note.tasks[i].text && task.done === this.#note.tasks[i].done)) return;
    this.#note = note;
    this.invalidate();
  }

  invalidate(): void { this.#width = -1; }
  releaseRenderCaches(): void { this.#rows = []; this.invalidate(); }

  render(width: number): readonly string[] {
    width = Math.max(1, Math.floor(width));
    if (width === this.#width) return this.#rows;
    const padding = width >= 8 ? 2 : 0;
    const inner = Math.max(1, width - padding * 2);
    const row = (text: string, bold = false) => {
      const fitted = truncateToWidth(text, inner);
      return PAPER + " ".repeat(padding) + (bold ? BOLD : "") + fitted + NORMAL +
        " ".repeat(Math.max(0, width - padding - visibleWidth(fitted))) + RESET;
    };
    const wrap = (text: string, limit: number, available: number): string[] => {
      const lines = wrapTextWithAnsi(cleanLabel(text), Math.max(1, available));
      if (lines.length > limit) {
        return [...lines.slice(0, limit - 1), truncateToWidth(lines.slice(limit - 1).join(" "), available)];
      }
      return lines.length ? [...lines] : [""];
    };
    const rows = [row("")];
    for (const line of wrap(this.#note.title, 2, inner)) rows.push(row(line, true));
    rows.push(row(""));
    const tasks = this.#note.tasks.length ? this.#note.tasks.slice(0, 3) : [{ text: "", done: false }];
    for (const task of tasks) {
      const lines = wrap(task.text, 2, Math.max(1, inner - 4));
      for (let i = 0; i < lines.length; i++) {
        rows.push(row((i === 0 ? (task.done ? "[x] " : "[ ] ") : "    ") + lines[i]));
      }
    }
    rows.push(row(""));
    this.#width = width;
    this.#rows = rows;
    return rows;
  }
}
