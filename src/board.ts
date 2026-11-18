import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@oh-my-pi/pi-tui";
import type { OfficeSnapshot } from "./office.ts";
import { cleanLabel } from "./state.ts";

interface BoardSession {
  id: string;
  name: string;
  snapshot: OfficeSnapshot;
  self: boolean;
}

interface BoardOptions {
  sessions(): readonly BoardSession[];
  rows(): number;
  requestRender(): void;
  close(): void;
}

/** Read-only fullscreen mission control. Refreshing never changes LAN ownership. */
export class OfficeBoard implements Component {
  private offset = 0;
  private pageSize = 1;
  private maxOffset = 0;
  private disposed = false;
  private cached?: { width: number; height: number; rows: string[] };

  constructor(private readonly options: BoardOptions) {}

  refresh(): void {
    if (this.disposed) return;
    this.cached = undefined;
    this.options.requestRender();
  }

  invalidate(): void {
    this.cached = undefined;
  }

  render(width: number): readonly string[] {
    width = Math.max(1, Math.floor(width));
    const height = Math.max(1, Math.floor(this.options.rows()));
    if (this.cached?.width === width && this.cached.height === height) return this.cached.rows;
    const sessions = this.options.sessions();
    const rows: string[] = [];
    const wrapped = (text: string, prefix = "", continuation = prefix) => {
      const available = Math.max(1, width - Math.max(visibleWidth(prefix), visibleWidth(continuation)));
      const lines = wrapTextWithAnsi(cleanLabel(text), available);
      for (let i = 0; i < lines.length; i++) {
        rows.push(truncateToWidth((i === 0 ? prefix : continuation) + lines[i], width, ""));
      }
    };
    for (const session of sessions) {
      const marker = session.self ? "SELF" : "REMOTE";
      const color = session.self ? "\x1b[1;36m" : "\x1b[1m";
      const start = rows.length;
      wrapped(`${marker} · ${session.name} · ${session.snapshot.attention.toUpperCase()} · #${session.id.slice(0, 8)}`);
      for (let i = start; i < rows.length; i++) rows[i] = color + rows[i] + "\x1b[0m";
      wrapped(session.snapshot.title || "(untitled)", "Project: ", "         ");
      for (const task of session.snapshot.tasks) wrapped(task.text, task.done ? "[x] " : "[ ] ", "    ");
      if (!session.snapshot.tasks.length) wrapped("(no tasks)");
      rows.push("");
    }
    if (!sessions.length) rows.push("No shared sessions available.");
    const headline = "\x1b[1mOffice — Mission control\x1b[0m";
    const remote = sessions.filter(session => !session.self).length;
    const header = height >= 5
      ? [headline, `${sessions.length} sessions · ${remote} remote · live updates every second`, "─".repeat(width)]
      : [headline];
    const viewportRows = Math.max(0, height - header.length - 1);
    this.pageSize = Math.max(1, viewportRows);
    this.maxOffset = Math.max(0, rows.length - this.pageSize);
    this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));
    const viewport = rows.slice(this.offset, this.offset + viewportRows);
    const output = header.map(line => truncateToWidth(line, width, ""));
    output.push(...viewport);
    while (output.length < height - 1) output.push("");
    const range = `${this.offset + 1}–${Math.min(rows.length, this.offset + this.pageSize)}/${rows.length}`;
    output.push(truncateToWidth(`Esc/q close · ↑↓ scroll · PgUp/PgDn · Home/End · r refresh · ${range}`, width, ""));
    const result = output.slice(0, height);
    this.cached = { width, height, rows: result };
    return result;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, "escape") || data === "q") {
      this.options.close();
      return;
    }
    if (matchesKey(data, "down") || data === "j") this.offset++;
    else if (matchesKey(data, "up") || data === "k") this.offset--;
    else if (matchesKey(data, "pageDown") || data === " ") this.offset += this.pageSize;
    else if (matchesKey(data, "pageUp")) this.offset -= this.pageSize;
    else if (matchesKey(data, "home")) this.offset = 0;
    else if (matchesKey(data, "end")) this.offset = this.maxOffset;
    else if (data !== "r") return;
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.cached = undefined;
  }
}
