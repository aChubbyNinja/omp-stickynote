import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getCellDimensions, TERMINAL, type Component, type OverlayHandle, type TUI } from "@oh-my-pi/pi-tui";
import { StickyNote } from "./note.ts";
import { MinimizedNote } from "./minimized.ts";
import { cleanLabel, ENTRY_TYPE, parseSaved, projectTasks, restore, sessionTitle, todoSnapshot, type SavedNote, type Task } from "./state.ts";
import { DesktopNote } from "./desktop.ts";
import { headlineLayout, PAPER_WIDTH } from "./paper.ts";
import { Effects, type VisualFrame } from "./effects.ts";
import { registerActivity } from "./activity.ts";
import { Office } from "./office.ts";
import { OfficeBoard } from "./board.ts";

const WIDGET = "omp-stickynote.owner";
const FUN_ENTRY = "omp-stickynote.fun";
interface SavedFun {
  version: 1;
  enabled: boolean;
}
const HELP = [
  "/sticky Title | task one | task two | task three",
  "/sticky auto · /sticky hide · /sticky show · /sticky done 1",
  "/sticky minimize — collapse to a yellow square; click it or use /sticky show to reopen",
  "/sticky boring mode — turn local effects off · /sticky fun on — turn them back on",
  "/sticky dnd [build|off] — DEEP WORK / WAITING ON A BUILD; Ctrl+Alt+D toggles",
  "/sticky crumple — dismiss visually; show restores the unchanged note",
  "/sticky office on|off|board — explicitly opt into LAN sharing for this session",
  "Hiding, crumpling or leaving the session turns office sharing off.",
  "Set OMP_STICKY_DND_SHORTCUT=off before starting OMP to leave Ctrl+Alt+D unbound.",
].join("\n");

function restoredFun(entries: readonly unknown[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;
    const custom = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (custom.type !== "custom" || custom.customType !== FUN_ENTRY || !custom.data || typeof custom.data !== "object") continue;
    const data = custom.data as { version?: unknown; enabled?: unknown };
    if (data.version === 1 && typeof data.enabled === "boolean") return data.enabled;
  }
  return true;
}

export default function stickynote(pi: ExtensionAPI): void {
  const dndShortcut = process.env.OMP_STICKY_DND_SHORTCUT !== "off";
  pi.setLabel("OMP Stickynote");
  let saved: SavedNote = { version: 1, hidden: false, manual: null };
  let tasks: Task[] = [];
  let taskRows: Task[] = [];
  let todoSource: string | undefined;
  let todoGeneration: string | undefined;
  let tui: TUI | undefined;
  let overlay: OverlayHandle | undefined;
  let mounted: Component | undefined;
  let tile: MinimizedNote | undefined;
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
  let lifecycle = 0;
  let sessionId: string | undefined;
  let crumpled = false;
  let crumpling = false;
  let dnd: "DEEP WORK" | "WAITING ON A BUILD" | undefined;
  let attention: VisualFrame["attention"] = "idle";
  let fx: Effects | undefined;
  let office: Office | undefined;
  let officeReady = false;
  let boardController: AbortController | undefined;
  let boardOpen = false;
  function noteOptions() {
    const owner = lifecycle;
    return {
      requestRender: () => { if (owner === lifecycle) { clearGraphics(); tui?.requestRender(true); } },
      maxRows: () => Math.max(1, (tui?.terminal.rows ?? 24) - 7),
      onError: (error: unknown) => {
        if (owner === lifecycle) current?.ui.notify(`Sticky note graphics unavailable: ${String(error)}`, "warning");
      },
    };
  }
  let note = new StickyNote(noteOptions());

  function title(): string {
    return sessionTitle(current?.sessionManager.getSessionName() ?? "");
  }

  function active(ctx: ExtensionContext): boolean {
    return !!current && ctx.mode === "tui" && ctx.agent.kind === "main" &&
      ctx.sessionManager.getSessionId() === sessionId &&
      current.sessionManager.getSessionId() === sessionId;
  }

  function visible(): boolean {
    return !saved.hidden && !crumpled;
  }

  function content() {
    return saved.manual ?? { title: title(), tasks: taskRows, progress: tasks };
  }

  function stopSharing(): void {
    boardController?.abort();
    const previous = office;
    office = undefined;
    officeReady = false;
    previous?.stop();
  }

  function share(): void {
    if (visible() && !crumpling) office?.update({ ...content(), attention });
    else stopSharing();
  }

  function contentChanged(baseline = false): void {
    fx?.note(content(), baseline);
    share();
    paint();
  }

  function restoreCard(): void {
    crumpled = false;
    crumpling = false;
    fx?.note(content(), true);
  }

  function expandTile(ctx: ExtensionContext): void {
    if (!active(ctx) || !saved.minimized || !visible() || crumpling || boardOpen) return;
    saved = { ...saved, minimized: false };
    restoreCard();
    save(ctx);
  }

  const activity = registerActivity(pi, {
    active,
    attention: value => { attention = value; fx?.attention(value); share(); },
    crew: value => fx?.crew(value),
    milestone: value => {
      fx?.milestone(value);
      if (value === "RELEASED" && officeReady) office?.release();
    },
  });

  function setDnd(value: typeof dnd, ctx: ExtensionContext): void {
    dnd = value;
    fx?.dnd(value);
    ctx.ui.notify(value ? `Sticky note: ${value}. Run /sticky dnd off to restore the card.` : "Sticky note: original card restored.", "info");
  }

  async function enableOffice(ctx: ExtensionContext): Promise<void> {
    if (!visible() || crumpling) return ctx.ui.notify("Show the sticky note before enabling office sharing.", "warning");
    if (office) return ctx.ui.notify(officeReady ? "Sticky office sharing is already on." : "Sticky office sharing is starting.", "info");
    const owner = lifecycle;
    const owned = new Office(
      () => { if (owner === lifecycle && office === owned) fx?.wave(); },
      error => {
        if (owner !== lifecycle || office !== owned) return;
        stopSharing();
        ctx.ui.notify(`Sticky office sharing stopped: ${String(error)}`, "warning");
      },
    );
    office = owned;
    share();
    try {
      await owned.start();
      if (owner !== lifecycle || office !== owned || !active(ctx) || !visible()) { owned.stop(); return; }
      officeReady = true;
      share();
      ctx.ui.notify("Sticky office sharing is on for this session. /sticky office board opens mission control; /sticky office off stops sharing.", "info");
    } catch (error) {
      if (owner !== lifecycle || office !== owned) return;
      stopSharing();
      ctx.ui.notify(`Sticky office could not start: ${String(error)}`, "warning");
    }
  }

  async function showBoard(ctx: ExtensionContext): Promise<void> {
    const owned = office;
    if (!owned || !officeReady) return ctx.ui.notify("Sticky office is off or still starting. Use /sticky office on to explicitly enable LAN sharing first.", "info");
    const owner = lifecycle;
    boardController?.abort();
    const controller = new AbortController();
    boardController = controller;
    boardOpen = true;
    unmount();
    let board: OfficeBoard | undefined;
    let refresh: NodeJS.Timeout | undefined;
    try {
      await ctx.ui.custom<void>((liveTui, _theme, _keybindings, done) => {
        board = new OfficeBoard({
          sessions: () => owned.sessions(),
          rows: () => liveTui.terminal.rows,
          requestRender: () => liveTui.requestRender(),
          close: () => done(undefined),
        });
        refresh = ctx.setInterval(() => {
          if (owner !== lifecycle || !active(ctx) || office !== owned) controller.abort();
          else board?.refresh();
        }, 1000);
        return board;
      }, {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, fullscreen: true, mouseTracking: false },
        signal: controller.signal,
      });
    } catch (error) {
      if (!controller.signal.aborted && active(ctx)) {
        ctx.ui.notify(`Sticky office board unavailable: ${String(error)}`, "warning");
      }
    } finally {
      if (refresh !== undefined) ctx.clearTimer(refresh);
      board?.dispose();
      if (boardController === controller) {
        boardController = undefined;
        boardOpen = false;
        if (owner === lifecycle && active(ctx)) { mount(); paint(); }
      }
    }
  }

  function overlayWidth(): number {
    const width = centered && TERMINAL.imageProtocol ? headlineLayout(dnd ?? content().title).width : PAPER_WIDTH;
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
      centered, minimized: !!saved.minimized, visible: visible && !saved.hidden && !crumpled && !boardOpen,
    });
  }

  function paint(): void {
    clearGraphics();
    if (!fx) return;
    if (saved.minimized) return;
    const next = content();
    note.update(next, fx.frame);
    desktop?.update(next, fx.frame);
    const entry = tui?.overlayStack.find(item => item.component === note);
    if (entry?.options) entry.options.width = overlayWidth();
    tui?.requestRender(true);
  }

  function unmount(): void {
    clearGraphics();
    paintDesktop(false);
    tile?.deactivate();
    overlay?.hide();
    overlay = undefined;
    mounted = undefined;
    tui?.requestRender(true);
  }

  function mount(): void {
    if (!tui || !visible() || boardOpen) return;
    if (desktop) {
      // Only the paint listener knows whether a host dialog or alternate buffer covers us.
      tui.requestRender();
      return;
    }
    const component = saved.minimized ? tile : note;
    if (!component || mounted === component) return;
    if (overlay) unmount();
    const previous = tui.getFocused();
    overlay = tui.showOverlay(component, component === tile ? tile.overlayOptions : {
      anchor: centered ? "top-center" : "top-right",
      width: overlayWidth(),
      margin: { top: 0, right: 2, left: 1, bottom: 4 },
      maxHeight: "100%",
    });
    // OMP 18.21 has no passive overlay option. Its public stack uses `released`
    // for sheets that remain visible without holding keyboard focus. Keep this
    // compatibility seam here; never replace the editor or intercept keystrokes.
    mounted = component;
    const entry = tui.overlayStack.find(item => item.component === component);
    if (entry) entry.released = true;
    tui.setFocus(previous);
    if (component === tile) tile.activate(tui);
  }

  function sync(ctx: ExtensionContext, force = false): void {
    if (!active(ctx)) return;
    const leaf = ctx.sessionManager.getLeafId();
    const nextTitle = title();
    if (!force && leaf === lastLeaf && nextTitle === lastTitle) return;
    let baseline = force;
    if (force || leaf !== lastLeaf) {
      const branch = ctx.sessionManager.getBranch();
      const restored = restore(branch);
      ({ saved, tasks } = restored);
      taskRows = projectTasks(tasks);
      baseline ||= !!restored.todo?.reset && restored.todo.source !== todoSource;
      todoSource = restored.todo?.source;
      todoGeneration = restored.todo?.generation;
      fx?.fun(restoredFun(branch));
      lastLeaf = leaf;
    }
    lastTitle = nextTitle;
    if (!visible()) unmount();
    else mount();
    contentChanged(baseline);
  }

  function save(ctx: ExtensionContext): void {
    if (!active(ctx)) return;
    pi.appendEntry(ENTRY_TYPE, saved);
    lastLeaf = ctx.sessionManager.getLeafId();
    if (!visible()) unmount();
    else mount();
    contentChanged();
  }

  function stop(): void {
    lifecycle++;
    const previous = current;
    current = undefined;
    sessionId = undefined;
    stopSharing();
    boardController = undefined;
    boardOpen = false;
    activity.reset();
    fx?.dispose();
    fx = undefined;
    if (timer !== undefined) previous?.clearTimer(timer);
    timer = undefined;
    removePaintListener?.();
    removePaintListener = undefined;
    unmount();
    tile?.dispose();
    tile = undefined;
    desktop?.dispose();
    desktop = undefined;
    note.dispose();
    tui = undefined;
    lastLeaf = undefined;
    lastTitle = undefined;
    todoSource = undefined;
    todoGeneration = undefined;
    crumpled = false;
    crumpling = false;
    dnd = undefined;
    attention = "idle";
  }

  function start(ctx: ExtensionContext): void {
    if (ctx.agent.kind !== "main") return;
    if (ctx.mode !== "tui") { stop(); return; }
    stop();
    current = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    const owner = lifecycle;
    fx = new Effects(
      () => { if (owner === lifecycle) paint(); },
      () => {
        if (owner !== lifecycle) return;
        crumpled = true;
        crumpling = false;
        stopSharing();
        unmount();
      },
    );
    centered = false;
    hasStarted = false;
    historyRows = 0;
    note = new StickyNote(noteOptions());
    sync(ctx, true);
    const conflict = dndShortcut && typeof pi.getShortcutConflict === "function" ? pi.getShortcutConflict("ctrl+alt+d") : undefined;
    if (conflict) ctx.ui.notify("Ctrl+Alt+D is already assigned in OMP. Set OMP_STICKY_DND_SHORTCUT=off before starting OMP to keep its existing binding; use /sticky dnd.", "warning");
    ctx.ui.setWidget(WIDGET, liveTui => {
      if (owner !== lifecycle || !active(ctx)) return { render: () => [] };
      tui = liveTui;
      const ownedNote = note;
      tile = new MinimizedNote({ onRestore: () => {
        if (owner === lifecycle && note === ownedNote) expandTile(ctx);
      } });
      if (DesktopNote.available()) {
        desktop = new DesktopNote({
          onReady: () => { if (owner === lifecycle && note === ownedNote) paint(); },
          onRestore: () => {
            if (owner === lifecycle && note === ownedNote) expandTile(ctx);
          },
          onError: error => {
            if (owner !== lifecycle || note !== ownedNote) return;
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
        if (owner !== lifecycle || !active(ctx)) return;
        if (frame.reset) historyRows = 0;
        historyRows += frame.history.length;
        if (frame.alt || boardOpen || !visible()) { paintDesktop(false); return; }
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
          if (entry.component !== mounted) { paintDesktop(false); return; }
          break;
        }
        if (desktop) { paintDesktop(); return; }
        if (saved.minimized) return;
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
      const component: Component = {
        render: () => [],
        dispose: () => { if (owner === lifecycle && note === ownedNote) stop(); else ownedNote.dispose(); },
      };
      return component;
    });
    // Detect asynchronous session renames and manual edits in OMP's task board.
    // The branch is read only when its leaf changes, not on every repaint.
    timer = ctx.setInterval(() => { if (owner === lifecycle) sync(ctx); }, 750);
  }

  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_switch", (_event, ctx) => start(ctx));
  pi.on("session_branch", (_event, ctx) => start(ctx));
  pi.on("session_tree", (_event, ctx) => start(ctx));
  pi.on("session_clear", (_event, ctx) => start(ctx));
  pi.on("session_shutdown", (_event, ctx) => { if (active(ctx)) stop(); });
  pi.on("message_end", (event, ctx) => {
    if (!active(ctx)) return;
    const snapshot = todoSnapshot({ type: "message", message: event.message }, todoGeneration);
    if (!snapshot) return;
    // The host can notify before its branch append settles. Consume the event's
    // committed snapshot, not a stale getBranch(), so quick completions survive.
    tasks = snapshot.tasks;
    taskRows = projectTasks(tasks);
    todoSource = snapshot.source;
    todoGeneration = snapshot.generation;
    contentChanged(snapshot.reset);
  });
  pi.on("input", (event, ctx) => {
    if (active(ctx) && !event.text.trimStart().startsWith("/")) hasStarted = true;
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (active(ctx)) hasStarted = true;
  });

  if (dndShortcut) pi.registerShortcut("ctrl+alt+d", {
    description: "Toggle sticky note DEEP WORK card",
    handler: ctx => {
      if (!active(ctx)) return;
      if (typeof pi.getShortcutConflict === "function" && pi.getShortcutConflict("ctrl+alt+d")) {
        ctx.ui.notify("Ctrl+Alt+D is already assigned in OMP. Set OMP_STICKY_DND_SHORTCUT=off before starting OMP; use /sticky dnd or /sticky dnd off.", "warning");
        return;
      }
      setDnd(dnd ? undefined : "DEEP WORK", ctx);
    },
  });

  pi.registerCommand("sticky", {
    description: "Pin a title/tasks; auto, minimize, hide, show, done N, boring mode, fun on, dnd, crumple, office",
    handler: async (args, ctx) => {
      if (!active(ctx)) return ctx.ui.notify("Stickynote needs the active main interactive OMP terminal.", "warning");
      sync(ctx);
      const input = args.trim();
      if (!input || input === "help") return ctx.ui.notify(HELP, "info");
      if (input === "minimize") {
        if (!visible() || crumpling) return ctx.ui.notify("The note is dismissed. Use /sticky show first.", "info");
        if (!saved.minimized) {
          saved = { ...saved, minimized: true };
          save(ctx);
        }
        return;
      }
      if (input === "boring mode" || input === "fun on") {
        const fun = input === "fun on";
        const preference: SavedFun = { version: 1, enabled: fun };
        pi.appendEntry(FUN_ENTRY, preference);
        lastLeaf = ctx.sessionManager.getLeafId();
        fx?.fun(fun);
        return ctx.ui.notify(`${fun ? "Fun mode on" : "Boring mode on"} for this session branch. LAN sharing is unchanged.`, "info");
      }
      if (input === "dnd" || input === "dnd build" || input === "dnd off") {
        return setDnd(input === "dnd off" ? undefined : input === "dnd build" ? "WAITING ON A BUILD" : dnd ? undefined : "DEEP WORK", ctx);
      }
      if (input === "crumple") {
        if (!visible() || crumpling) return ctx.ui.notify("The sticky note is already dismissed or crumpling. Use /sticky show to restore it.", "info");
        stopSharing();
        crumpling = true;
        fx?.crumple();
        return ctx.ui.notify("Sticky note crumpled. /sticky show restores the unchanged note.", "info");
      }
      if (input === "office on") return enableOffice(ctx);
      if (input === "office off") {
        stopSharing();
        return ctx.ui.notify("Sticky office sharing is off.", "info");
      }
      if (input === "office board") return showBoard(ctx);
      if (input === "fun" || input === "office") {
        return ctx.ui.notify(HELP, "info");
      }
      const wasSharing = office !== undefined;
      if (input === "hide" || input === "show") {
        saved = { ...saved, hidden: input === "hide", minimized: false };
        if (input === "show") restoreCard();
        else if (crumpling) { crumpling = false; fx?.note(content(), true); }
      }
      else if (input === "auto") saved = { ...saved, manual: null };
      else if (/^done\s+[1-3]$/.test(input)) {
        const selected = Number(input.split(/\s+/)[1]) - 1;
        const manual = saved.manual;
        if (!manual || !manual.tasks[selected]) return ctx.ui.notify("Use done N with a manually pinned task. Automatic tasks follow OMP's todo list.", "warning");
        saved = { ...saved, manual: { ...manual, tasks: manual.tasks.map((task, i) => i === selected ? { ...task, done: !task.done } : task) } };
      } else {
        const [heading, ...items] = input.split("|").map(cleanLabel);
        if (!heading || items.length > 3 || items.some(item => !item)) return ctx.ui.notify(HELP, "warning");
        saved = { ...saved, hidden: false, manual: { title: heading, tasks: (items.length ? items : [""]).map(text => ({ text, done: false })) } };
        if (crumpled || crumpling) restoreCard();
      }
      save(ctx);
      if (input === "hide" && wasSharing) ctx.ui.notify("Sticky note hidden; office sharing is off.", "info");
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
      if (ctx.agent.kind !== "main") throw new Error("Sticky note updates are only available to the main session.");
      const parsed = parseSaved({ version: 1, hidden: false, manual: params });
      const manual = parsed?.manual;
      if (!manual?.title || manual.tasks.some(task => !task.text)) throw new Error("Sticky note labels must contain visible text.");
      if (ctx.mode === "tui") {
        if (!active(ctx)) throw new Error("Sticky note updates require the active main interactive OMP session.");
        sync(ctx);
        saved = { ...saved, hidden: false, manual };
        if (crumpled || crumpling) restoreCard();
        save(ctx);
      } else {
        const previous = restore(ctx.sessionManager.getBranch()).saved;
        pi.appendEntry(ENTRY_TYPE, { ...previous, hidden: false, manual } satisfies SavedNote);
      }
      return { content: [{ type: "text", text: "Sticky note updated." }], details: manual };
    },
  });
}
