import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getCellDimensions, TERMINAL, type Component, type OverlayHandle, type TUI } from "@oh-my-pi/pi-tui";
import { StickyNote } from "./note.ts";
import { cleanLabel, ENTRY_TYPE, parseSaved, restore, sessionTitle, type SavedNote, type Task } from "./state.ts";
import { DesktopNote } from "./desktop.ts";
import { headlineLayout, PAPER_WIDTH } from "./paper.ts";

const WIDGET = "omp-stickynote.owner";
const HELP = "/sticky Title | task one | task two | task three\n/sticky auto · /sticky hide · /sticky show · /sticky done 1";

export default function stickynote(pi: ExtensionAPI): void {
  pi.setLabel("OMP Stickynote");
  let saved: SavedNote = { version: 1, hidden: false, manual: null };
  let tasks: Task[] = [];
  let tui: TUI | undefined;
  let overlay: OverlayHandle | undefined;
  let timer: NodeJS.Timeout | undefined;
  let lastLeaf: string | null | undefined;
  let lastTitle: string | undefined;
  let current: ExtensionContext | undefined;
  let centered = false;
  let hasStarted = false;
  let historyRows = 0;
  let desktop: DesktopNote | undefined;
  let removePaintListener: (() => void) | undefined;
  let painted: { row: number; col: number; width: number; height: number } | undefined;
  const noteOptions = {
    requestRender: () => { clearGraphics(); tui?.requestRender(true); },
    maxRows: () => Math.max(1, (tui?.terminal.rows ?? 24) - 7),
    onError: (error: unknown) => current?.ui.notify(`Sticky note graphics unavailable: ${String(error)}`, "warning"),
  };
  let note = new StickyNote(noteOptions);

  function title(): string {
    return sessionTitle(pi.getSessionName() ?? "");
  }

  function overlayWidth(): number {
    const width = centered && TERMINAL.imageProtocol ? headlineLayout(saved.manual?.title ?? title()).width : PAPER_WIDTH;
    return Math.ceil(width / 10) + 2;
  }

  function restoreCursor(): string {
    const cursor = tui?.getDebugPaint()?.cursor;
    return cursor
      ? `\x1b[${cursor.y + 1};${cursor.x + 1}H${cursor.visible ? "\x1b[?25h" : "\x1b[?25l"}`
      : "\x1b[?25l";
  }

  function clearGraphics(): void {
    const rect = painted;
    painted = undefined;
    if (!rect || !tui || tui.getDebugPaint()?.altScreen) return;
    let output = "\x1b[?2026h\x1b[0m";
    for (let y = 0; y < rect.height; y++) {
      output += `\x1b[${rect.row + y + 1};${rect.col + 1}H\x1b[${rect.width}X`;
    }
    tui.terminal.write(output + restoreCursor() + "\x1b[?2026l");
  }

  function paintDesktop(visible = true): void {
    if (!desktop || !tui) return;
    const cell = getCellDimensions();
    desktop.render({
      columns: tui.terminal.columns, rows: tui.terminal.rows,
      cellWidthPx: cell.widthPx, cellHeightPx: cell.heightPx,
      centered, visible: visible && !saved.hidden,
    });
  }

  function paint(): void {
    clearGraphics();
    const content = saved.manual ?? { title: title(), tasks };
    note.update(content);
    desktop?.update(content);
    const entry = tui?.overlayStack.find(item => item.component === note);
    if (entry?.options) entry.options.width = overlayWidth();
    tui?.requestRender(true);
  }

  function unmount(): void {
    clearGraphics();
    paintDesktop(false);
    overlay?.hide();
    overlay = undefined;
    tui?.requestRender(true);
  }

  function mount(): void {
    if (!tui || saved.hidden || overlay || desktop) return;
    const previous = tui.getFocused();
    overlay = tui.showOverlay(note, {
      anchor: centered ? "top-center" : "top-right",
      width: overlayWidth(),
      margin: { top: 0, right: 2, left: 1, bottom: 4 },
      maxHeight: "100%",
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
    const nextTitle = title();
    if (!force && leaf === lastLeaf && nextTitle === lastTitle) return;
    if (force || leaf !== lastLeaf) {
      ({ saved, tasks } = restore(ctx.sessionManager.getBranch()));
      lastLeaf = leaf;
    }
    lastTitle = nextTitle;
    if (saved.hidden) unmount();
    else mount();
    paint();
  }

  function save(ctx: ExtensionContext): void {
    pi.appendEntry(ENTRY_TYPE, saved);
    lastLeaf = ctx.sessionManager.getLeafId();
    if (saved.hidden) unmount();
    else mount();
    paint();
  }

  function stop(): void {
    if (timer !== undefined) current?.clearTimer(timer);
    timer = undefined;
    removePaintListener?.();
    removePaintListener = undefined;
    desktop?.dispose();
    desktop = undefined;
    note.dispose();
    unmount();
    tui = undefined;
  }

  function start(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || ctx.agent.kind !== "main") return;
    stop();
    current = ctx;
    centered = false;
    hasStarted = false;
    historyRows = 0;
    note = new StickyNote(noteOptions);
    sync(ctx, true);
    ctx.ui.setWidget(WIDGET, liveTui => {
      tui = liveTui;
      const ownedNote = note;
      if (DesktopNote.available()) {
        desktop = new DesktopNote({
          onReady: () => { if (note === ownedNote) paint(); },
          onError: error => {
            if (note !== ownedNote) return;
            const failed = desktop;
            desktop = undefined;
            failed?.dispose();
            ctx.ui.notify(`Sticky note desktop overlay unavailable; using terminal rendering: ${String(error)}`, "warning");
            mount();
            paint();
          },
        });
      } else if (process.platform === "linux" && process.env.HYPRLAND_INSTANCE_SIGNATURE &&
          process.env.OMP_STICKY_RENDERER !== "terminal") {
        ctx.ui.notify("Sticky note is using terminal rendering. Build native/bin/build in the extension checkout for a scrollback-safe desktop overlay.", "info");
      }
      removePaintListener = liveTui.addPaintListener(frame => {
        if (frame.reset) historyRows = 0;
        historyRows += frame.history.length;
        if (frame.alt || saved.hidden) { paintDesktop(false); return; }
        if (hasStarted && !centered && historyRows + frame.viewport.length > frame.rows) {
          clearGraphics();
          centered = true;
          const entry = liveTui.overlayStack.find(item => item.component === ownedNote);
          if (entry?.options) {
            entry.options.anchor = "top-center";
            entry.options.width = overlayWidth();
          }
          liveTui.requestRender(true);
          return;
        }
        // Never paint over a host dialog. Its own layer retains keyboard focus.
        for (let i = liveTui.overlayStack.length - 1; i >= 0; i--) {
          const entry = liveTui.overlayStack[i];
          if (entry.hidden || entry.options?.visible?.(frame.columns, frame.rows) === false) continue;
          if (entry.component !== ownedNote) { paintDesktop(false); return; }
          break;
        }
        if (desktop) { paintDesktop(); return; }
        const graphics = ownedNote.graphicsRows;
        if (!graphics) return;
        const width = Math.max(1, Math.min(overlayWidth(), frame.columns - 3));
        const col = centered ? 1 + Math.floor((frame.columns - 3 - width) / 2) : frame.columns - 2 - width;
        const row = 0;
        // OMP 18.21 slices partial-overlay rows as text, corrupting SIXEL.
        // The component reserves the rectangle with ordinary blank rows; emit
        // its cached Image rows after the host paint, without passing graphics
        // through that slicer. The mounted overlay keeps a full-height live
        // viewport, which OMP erases before pushing history into scrollback.
        let output = "\x1b[?2026h";
        for (let y = 0; y < graphics.length; y++) {
          output += `\x1b[${row + y + 1};${col + 1}H${graphics[y]}`;
        }
        liveTui.terminal.write(output + "\x1b[0m" + restoreCursor() + "\x1b[?2026l");
        painted = { row, col, width, height: graphics.length };
      });
      mount();
      paint();
      const owner: Component = {
        render: () => [],
        dispose: () => { if (note === ownedNote) stop(); else ownedNote.dispose(); },
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
  pi.on("input", (event, ctx) => {
    if (ctx.agent.kind === "main" && !event.text.trimStart().startsWith("/")) hasStarted = true;
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.agent.kind === "main") hasStarted = true;
  });

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
