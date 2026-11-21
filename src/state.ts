export interface Task {
  text: string;
  done: boolean;
  /** Exact host identity; labels are sanitized separately for display. */
  id?: string;
}

export interface Note {
  title: string;
  tasks: Task[];
  /** Full automatic todo snapshot, before the three-row display projection. */
  progress?: readonly Task[];
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
export function tasksFromPhases(value: unknown, generation = ""): Task[] | undefined {
  if (!Array.isArray(value)) return;
  const tasks: Task[] = [];
  const occurrences = new Map<string, number>();
  for (const phase of value) {
    if (!record(phase) || !Array.isArray(phase.tasks)) return;
    for (const task of phase.tasks) {
      if (!record(task) || typeof task.content !== "string") return;
      const identity = JSON.stringify([phase.name ?? "", task.content]);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      switch (task.status) {
        case "in_progress":
        case "pending":
        case "blocked": // OMP restores pre-removal blocked rows as pending.
        case "completed":
          tasks.push({
            id: JSON.stringify([generation, identity, occurrence]),
            text: cleanLabel(task.content),
            done: task.status === "completed",
          });
          break;
        case "abandoned":
          break;
        default:
          return;
      }
    }
  }
  return tasks;
}

/** Keep the card small without discarding the completion history effects need. */
export function projectTasks(tasks: readonly Task[]): Task[] {
  const open: Task[] = [];
  for (const task of tasks) {
    if (!task.done && open.push(task) === 3) return open;
  }
  return open.length ? open : tasks.slice(-3);
}

export interface TodoSnapshot {
  tasks: Task[];
  source?: string;
  generation?: string;
  reset: boolean;
}

/** The direct event and durable branch paths use the same canonical snapshot rules. */
export function todoSnapshot(entry: unknown, generation?: string): TodoSnapshot | undefined {
  if (!record(entry)) return;
  let phases: unknown;
  let source = typeof entry.id === "string" ? entry.id : undefined;
  let reset = false;
  if (entry.type === "custom" && entry.customType === "user_todo_edit" && record(entry.data)) {
    phases = entry.data.phases;
  } else if (entry.type === "message" && record(entry.message)) {
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError ||
        !record(message.details) || message.details.op === "view") return;
    phases = message.details.phases;
    if (typeof message.toolCallId === "string") source = message.toolCallId;
    reset = message.details.op === "init";
  } else return;
  if (reset) generation = source;
  const tasks = tasksFromPhases(phases, generation);
  if (!tasks) return;
  return { tasks, source, generation, reset };
}

/** Read only the current branch: never borrow tasks from a sibling session. */
export function restore(entries: readonly unknown[]): { saved: SavedNote; tasks: Task[]; todo?: TodoSnapshot } {
  let saved: SavedNote | undefined;
  let todo: TodoSnapshot | undefined;
  let todoEntry: unknown;
  let foundGeneration = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!record(entry)) continue;
    if (!saved && entry.type === "custom" && entry.customType === ENTRY_TYPE) {
      saved = parseSaved(entry.data);
    }
    const message = entry.type === "message" && record(entry.message) ? entry.message : undefined;
    if (!foundGeneration && (!todo || (message && record(message.details) && message.details.op === "init"))) {
      const snapshot = todoSnapshot(entry);
      if (snapshot) {
        if (!todo) { todo = snapshot; todoEntry = entry; }
        if (snapshot.reset) {
          todo = todoSnapshot(todoEntry, snapshot.generation);
          foundGeneration = true;
        }
      }
    }
    if (saved && foundGeneration) break;
  }
  return { saved: saved ?? { version: 1, hidden: false, manual: null }, tasks: todo?.tasks ?? [], todo };
}
