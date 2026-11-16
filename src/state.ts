export interface Task {
  text: string;
  done: boolean;
}

export interface Note {
  title: string;
  tasks: Task[];
}

export interface SavedNote {
  version: 1;
  hidden: boolean;
  manual: Note | null;
}

export const ENTRY_TYPE = "omp-stickynote.state";

/** Strip terminal control sequences before allowing untrusted labels on screen. */
export function cleanLabel(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** OMP's terminal icon/tag is window chrome, not part of the project's headline. */
export function sessionTitle(name: string): string {
  return cleanLabel(name)
    .replace(/^[\p{Extended_Pictographic}\p{Co}\uFE0F\u200D]+\s+[A-Z][A-Z0-9_-]*:\s*/u, "")
    .trim() || "Ready to begin";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function parseSaved(value: unknown): SavedNote | undefined {
  if (!record(value) || value.version !== 1 || typeof value.hidden !== "boolean") return;
  if (value.manual === null) return { version: 1, hidden: value.hidden, manual: null };
  const note = value.manual;
  if (!record(note) || typeof note.title !== "string" || !cleanLabel(note.title)) return;
  if (!Array.isArray(note.tasks) || note.tasks.length < 1 || note.tasks.length > 3) return;
  const tasks: Task[] = [];
  for (const task of note.tasks) {
    if (!record(task) || typeof task.text !== "string" || typeof task.done !== "boolean") return;
    tasks.push({ text: cleanLabel(task.text), done: task.done });
  }
  return { version: 1, hidden: value.hidden, manual: { title: cleanLabel(note.title), tasks } };
}

/** Undefined means not a valid snapshot; [] means the task list was cleared. */
export function tasksFromPhases(value: unknown): Task[] | undefined {
  if (!Array.isArray(value)) return;
  const open: Task[] = [];
  const completed: Task[] = [];
  for (const phase of value) {
    if (!record(phase) || !Array.isArray(phase.tasks)) return;
    for (const task of phase.tasks) {
      if (!record(task) || typeof task.content !== "string") return;
      const text = cleanLabel(task.content);
      switch (task.status) {
        case "in_progress":
        case "pending":
          open.push({ text, done: false });
          break;
        case "completed":
          completed.push({ text, done: true });
          break;
        case "abandoned":
          break;
        default:
          return;
      }
    }
  }
  return open.length ? open.slice(0, 3) : completed.slice(-3);
}

/** Read only the current branch: never borrow tasks from a sibling session. */
export function restore(entries: readonly unknown[]): { saved: SavedNote; tasks: Task[] } {
  let saved: SavedNote | undefined;
  let tasks: Task[] | undefined;
  for (let i = entries.length - 1; i >= 0 && (!saved || !tasks); i--) {
    const entry = entries[i];
    if (!record(entry)) continue;
    if (!saved && entry.type === "custom" && entry.customType === ENTRY_TYPE) {
      saved = parseSaved(entry.data);
    }
    if (tasks) continue;
    if (entry.type === "custom" && entry.customType === "user_todo_edit" && record(entry.data)) {
      tasks = tasksFromPhases(entry.data.phases);
    } else if (entry.type === "message" && record(entry.message)) {
      const message = entry.message;
      if (message.role === "toolResult" && message.toolName === "todo" && !message.isError &&
          record(message.details) && message.details.op !== "view") {
        tasks = tasksFromPhases(message.details.phases);
      }
    }
  }
  return { saved: saved ?? { version: 1, hidden: false, manual: null }, tasks: tasks ?? [] };
}
