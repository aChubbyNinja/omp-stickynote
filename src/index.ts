import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { StickyNote } from "./note.ts";
import { cleanLabel, ENTRY_TYPE, parseSaved, restore, type SavedNote, type Task } from "./state.ts";

const WIDGET = "omp-stickynote.owner";
const HELP = "/sticky Title | task one | task two | task three\n/sticky auto · /sticky hide · /sticky show · /sticky done 1";

export default function stickynote(pi: ExtensionAPI): void {
  pi.setLabel("OMP Stickynote");
  const note = new StickyNote();
  let saved: SavedNote = { version: 1, hidden: false, manual: null };
  let tasks: Task[] = [];
  let tui: TUI | undefined;
  let overlay: OverlayHandle | undefined;
  let timer: NodeJS.Timeout | undefined;
  let lastLeaf: string | null | undefined;
  let lastTitle: string | undefined;
  let current: ExtensionContext | undefined;

  function title(ctx: ExtensionContext): string {
    return cleanLabel(pi.getSessionName() || basename(ctx.cwd) || "Project");
  }

  function paint(ctx: ExtensionContext): void {
    note.update(saved.manual ?? { title: title(ctx), tasks });
    tui?.requestRender();
  }

  function unmount(): void {
    overlay?.hide();
    overlay = undefined;
  }

  function mount(): void {
    if (!tui || saved.hidden || overlay) return;
    const previous = tui.getFocused();
    overlay = tui.showOverlay(note, {
      anchor: "top-right",
      width: 38,
      margin: { top: 1, right: 2, left: 1, bottom: 4 },
      maxHeight: 11,
    });
    // OMP 18.21 has no passive overlay option. Its public stack uses `released`
    // for sheets that remain visible without holding keyboard focus. Keep this
    // compatibility seam here; never replace the editor or intercept keystrokes.
    const entry = tui.overlayStack.find(item => item.component === note);
    if (entry) entry.released = true;
    tui.setFocus(previous);
  }

  function sync(ctx: ExtensionContext, force = false): void {
    const leaf = ctx.sessionManager.getLeafId();
    const nextTitle = title(ctx);
    if (!force && leaf === lastLeaf && nextTitle === lastTitle) return;
    if (force || leaf !== lastLeaf) {
      ({ saved, tasks } = restore(ctx.sessionManager.getBranch()));
      lastLeaf = leaf;
    }
    lastTitle = nextTitle;
    if (saved.hidden) unmount();
    else mount();
    paint(ctx);
  }

  function save(ctx: ExtensionContext): void {
    pi.appendEntry(ENTRY_TYPE, saved);
    lastLeaf = ctx.sessionManager.getLeafId();
    if (saved.hidden) unmount();
    else mount();
    paint(ctx);
  }

  function stop(): void {
    if (timer !== undefined) current?.clearTimer(timer);
    timer = undefined;
    unmount();
    tui = undefined;
  }

  function start(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || ctx.agent.kind !== "main") return;
    stop();
    current = ctx;
    sync(ctx, true);
    ctx.ui.setWidget(WIDGET, liveTui => {
      tui = liveTui;
      mount();
      const owner: Component = {
        render: () => [],
        dispose: () => { unmount(); tui = undefined; },
      };
      return owner;
    });
    // Detect asynchronous session renames and manual edits in OMP's task board.
    // The branch is read only when its leaf changes, not on every repaint.
    timer = ctx.setInterval(() => sync(ctx), 750);
  }

  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_switch", (_event, ctx) => start(ctx));
  pi.on("session_branch", (_event, ctx) => start(ctx));
  pi.on("session_tree", (_event, ctx) => start(ctx));
  pi.on("session_shutdown", () => stop());

  pi.registerCommand("sticky", {
    description: "Pin a project title and 1–3 tasks; auto, hide, show, or done N",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return ctx.ui.notify("Stickynote needs an interactive OMP terminal.", "warning");
      sync(ctx);
      const input = args.trim();
      if (!input) return ctx.ui.notify(HELP, "info");
      if (input === "hide" || input === "show") saved = { ...saved, hidden: input === "hide" };
      else if (input === "auto") saved = { ...saved, manual: null };
      else if (/^done\s+[1-3]$/.test(input)) {
        const selected = Number(input.split(/\s+/)[1]) - 1;
        const manual = saved.manual;
        if (!manual || !manual.tasks[selected]) return ctx.ui.notify("Use done N with a manually pinned task. Automatic tasks follow OMP's todo list.", "warning");
        saved = { ...saved, manual: { ...manual, tasks: manual.tasks.map((task, i) => i === selected ? { ...task, done: !task.done } : task) } };
      } else {
        const [heading, ...items] = input.split("|").map(cleanLabel);
        if (!heading || items.length > 3 || items.some(item => !item)) return ctx.ui.notify(HELP, "warning");
        saved = { version: 1, hidden: false, manual: { title: heading, tasks: (items.length ? items : [""]).map(text => ({ text, done: false })) } };
      }
      save(ctx);
    },
  });

  pi.registerTool({
    name: "sticky_note",
    label: "Sticky note",
    description: "Pin a concise project title and 1–3 short task labels on the session's yellow sticky note. Use only when asked to set or update the note; otherwise it automatically follows the session title and OMP todos. Manual notes persist until /sticky auto.",
    parameters: pi.zod.object({
      title: pi.zod.string().min(1).max(100),
      tasks: pi.zod.array(pi.zod.object({ text: pi.zod.string().min(1).max(160), done: pi.zod.boolean() })).min(1).max(3),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const parsed = parseSaved({ version: 1, hidden: false, manual: params });
      const manual = parsed?.manual;
      if (!manual?.title || manual.tasks.some(task => !task.text)) throw new Error("Sticky note labels must contain visible text.");
      saved = { version: 1, hidden: false, manual };
      save(ctx);
      return { content: [{ type: "text", text: "Sticky note updated." }], details: manual };
    },
  });
}
