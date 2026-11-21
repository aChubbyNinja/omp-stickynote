import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import { getImageDimensions } from "@oh-my-pi/pi-tui";
import { continuesAnimation, visualFrameKey } from "./art.ts";
import type { VisualFrame } from "./effects.ts";
import { PAPER_WIDTH, paperSvg } from "./paper.ts";
import { cleanLabel, type Note } from "./state.ts";

interface DesktopOptions {
  onReady: () => void;
  onRestore: () => void;
  onMinimize: () => void;
  onError: (error: unknown) => void;
}

interface DesktopFrame {
  columns: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
  centered: boolean;
  visible: boolean;
  minimized: boolean;
}

interface RasterRequest {
  key: string;
  scene: string;
  svg: string;
  width: number;
  height: number;
  scale: number;
}

const EXECUTABLE = "omp-stickynote-overlay";
const READY_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 750;
const COMPOSER_ROWS = 7;
const ignoreError = () => {};

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function rendererPath(): string | undefined {
  if (process.platform !== "linux" || process.env.OMP_STICKY_RENDERER === "terminal" ||
      !process.env.HYPRLAND_INSTANCE_SIGNATURE || !process.env.XDG_RUNTIME_DIR || !process.env.WAYLAND_DISPLAY) return;
  const bundled = fileURLToPath(new URL(`../native/build/${EXECUTABLE}`, import.meta.url));
  if (executable(bundled)) return bundled;
  const prebuilt = fileURLToPath(new URL(`../native/prebuilt/${process.platform}-${process.arch}/${EXECUTABLE}`, import.meta.url));
  if (executable(prebuilt)) return prebuilt;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(directory, EXECUTABLE);
    if (executable(path)) return path;
  }
}

function sameFrame(left: DesktopFrame | undefined, right: DesktopFrame): boolean {
  return left !== undefined && left.columns === right.columns && left.rows === right.rows &&
    left.cellWidthPx === right.cellWidthPx && left.cellHeightPx === right.cellHeightPx &&
    left.centered === right.centered && left.visible === right.visible && left.minimized === right.minimized;
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** An alpha-PNG desktop surface; the caller owns terminal fallback after onError. */
export class DesktopNote {
  #options: DesktopOptions;
  #child?: ChildProcessWithoutNullStreams;
  #stoppingChild?: ChildProcessWithoutNullStreams;
  #ready = false;
  #failed = false;
  #disposed = false;
  #readyTimer?: NodeJS.Timeout;
  #stdout = "";
  #stderr = "";
  #note: Note = { title: "Ready to begin", tasks: [] };
  #fx?: VisualFrame;
  #fxKey = "";
  #revision = 0;
  #scene = 0;
  #interactionScene = 0;
  #sentScene?: number;
  #frame?: DesktopFrame;
  #sentFrame?: DesktopFrame;
  #sentRasterKey?: string;
  #blocked = false;
  #paper?: { rowHeight: number; maxWidth: number; svg: string; width: number; height: number };
  #desired?: RasterRequest;
  #raster?: { key: string; scene: string; png: string };
  #running = false;
  #scheduled = false;

  static available(): boolean {
    return rendererPath() !== undefined;
  }

  constructor(options: DesktopOptions) {
    this.#options = options;
    try {
      const path = rendererPath();
      if (!path) throw new Error("The desktop sticky note renderer is unavailable; use the terminal renderer");
      // Extensions run inside OMP, including worker threads, so this is OMP's PID.
      const child = spawn(path, ["--parent-pid", String(process.pid)], { stdio: ["pipe", "pipe", "pipe"] });
      this.#child = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", this.#onStdout);
      child.stderr.on("data", this.#onStderr);
      child.stdout.on("error", this.#onChildError);
      child.stderr.on("error", this.#onChildError);
      child.stdin.on("error", this.#onChildError);
      child.stdin.on("drain", this.#onDrain);
      child.on("error", this.#onChildError);
      child.on("exit", this.#onChildExit);
      process.once("exit", this.#onParentExit);
      this.#readyTimer = setTimeout(() => this.#fail(new Error(this.#diagnostic("Desktop sticky note renderer did not become ready within five seconds"))), READY_TIMEOUT_MS);
      this.#readyTimer.unref();
    } catch (error) {
      // Let the caller retain this instance before a synchronous spawn failure falls back.
      queueMicrotask(() => this.#fail(error));
    }
  }

  get ready(): boolean {
    return this.#ready && !this.#disposed && !this.#failed;
  }

  update(note: Note, fx?: VisualFrame): void {
    if (this.#disposed || this.#failed) return;
    const next: Note = {
      title: cleanLabel(note.title),
      tasks: note.tasks.slice(0, 3).map(task => ({ text: cleanLabel(task.text), done: task.done })),
    };
    const fxKey = fx === this.#fx ? this.#fxKey : visualFrameKey(fx);
    const sameNote = next.title === this.#note.title && next.tasks.length === this.#note.tasks.length &&
      next.tasks.every((task, index) => task.text === this.#note.tasks[index].text && task.done === this.#note.tasks[index].done);
    if (sameNote && fxKey === this.#fxKey) return;
    if (!sameNote || !continuesAnimation(this.#fx, fx)) {
      this.#scene++;
      this.#raster = undefined;
    }
    if (!sameNote) this.#interactionScene++;
    this.#fx = fx;
    this.#fxKey = fxKey;
    this.#note = next;
    this.#revision++;
    this.#paper = undefined;
    this.#desired = undefined;
    this.#refresh();
  }

  render(frame: DesktopFrame): void {
    if (this.#disposed || this.#failed) return;
    const next: DesktopFrame = {
      columns: Math.max(1, Math.floor(positive(frame.columns))),
      rows: Math.max(1, Math.floor(positive(frame.rows))),
      cellWidthPx: positive(frame.cellWidthPx),
      cellHeightPx: positive(frame.cellHeightPx),
      centered: frame.centered,
      visible: frame.visible,
      minimized: frame.minimized,
    };
    if (sameFrame(this.#frame, next)) return;
    this.#interactionScene++;
    if (this.#frame?.minimized !== next.minimized) {
      // A restored surface must wait for its current note, never reuse the
      // pre-minimize PNG or accept an in-flight raster from that scene.
      this.#scene++;
      this.#desired = undefined;
      this.#raster = undefined;
      this.#sentRasterKey = undefined;
    }
    this.#frame = next;
    this.#refresh();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ready = false;
    this.#desired = undefined;
    this.#raster = undefined;
    this.#paper = undefined;
    this.#frame = undefined;
    this.#sentFrame = undefined;
    this.#stop();
  }

  #refresh(): void {
    const frame = this.#frame;
    if (!frame) return;
    if (frame.visible && !frame.minimized) {
      const baseScale = Math.min(52, Math.max(1, frame.columns - 3)) * frame.cellWidthPx / 520;
      const height = Math.max(1, Math.floor(Math.max(1, frame.rows - COMPOSER_ROWS) * frame.cellHeightPx));
      const rowHeight = frame.cellHeightPx / baseScale;
      // The startup card stays compact. Centered cards have equal room on both sides.
      const maxWidth = frame.centered ? Math.max(1, frame.columns - 3) * frame.cellWidthPx / baseScale : PAPER_WIDTH;
      if (this.#paper?.rowHeight !== rowHeight || this.#paper.maxWidth !== maxWidth) {
        this.#paper = { rowHeight, maxWidth, ...paperSvg(this.#note, rowHeight, maxWidth, this.#fx) };
      }
      const paper = this.#paper;
      const width = Math.max(1, Math.floor(paper.width * baseScale));
      const scale = Math.min(width / paper.width, height / paper.height);
      // Unconstrained row/column changes do not invalidate the PNG. A short window
      // lowers one uniform scale, without distorting the paper or adding a cell mat.
      const geometry = `${rowHeight}/${paper.width}/${scale}`;
      const key = `${this.#revision}/${geometry}`;
      if (this.#desired?.key !== key) this.#desired = { key, scene: `${this.#scene}/${geometry}`, svg: paper.svg, width, height, scale };
    }
    this.#flush();
    this.#scheduleRaster();
  }

  #scheduleRaster(): void {
    if (!this.ready || this.#running || this.#scheduled || !this.#frame?.visible || this.#frame.minimized ||
        !this.#desired || this.#raster?.key === this.#desired.key) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      void this.#rasterize();
    });
  }

  async #rasterize(): Promise<void> {
    const request = this.#desired;
    if (!this.ready || this.#running || !this.#frame?.visible || this.#frame.minimized || !request || this.#raster?.key === request.key) return;
    this.#running = true;
    try {
      // No terminal-cell padding or SIXEL conversion: the companion needs true alpha.
      const png = await rasterizeSvg(new TextEncoder().encode(request.svg), request.width, request.height, request.scale);
      if (this.#disposed || this.#failed || this.#desired?.scene !== request.scene) return;
      const base64 = Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64");
      if (!getImageDimensions(base64, "image/png")) throw new Error("The desktop sticky note rasterizer returned an invalid PNG");
      this.#raster = { key: request.key, scene: request.scene, png: base64 };
      this.#flush();
    } catch (error) {
      if (this.#frame?.visible && this.#desired?.key === request.key) this.#fail(error);
    } finally {
      this.#running = false;
      this.#scheduleRaster();
    }
  }

  #flush(): void {
    const child = this.#child;
    const frame = this.#frame;
    if (!this.ready || !child || !frame || this.#blocked) return;
    const raster = this.#raster?.scene === this.#desired?.scene ? this.#raster : undefined;
    const png = frame.visible && !frame.minimized && raster && raster.key !== this.#sentRasterKey ? raster.png : undefined;
    if (!png && sameFrame(this.#sentFrame, frame) && this.#sentScene === this.#interactionScene) return;
    try {
      // A false return still accepts this frame. Keep only the latest state until
      // drain, instead of accumulating PNGs or geometry writes in the stream.
      this.#blocked = !child.stdin.write(`${JSON.stringify({ op: "frame", ...frame, scene: this.#interactionScene, ...(png ? { png } : {}) })}\n`);
      this.#sentFrame = frame;
      this.#sentScene = this.#interactionScene;
      if (png) this.#sentRasterKey = raster!.key;
    } catch (error) {
      this.#fail(error);
    }
  }

  #onDrain = (): void => {
    this.#blocked = false;
    this.#flush();
  };

  #onStderr = (chunk: string): void => {
    this.#stderr = (this.#stderr + chunk).slice(-4_096);
  };

  #onStdout = (chunk: string): void => {
    if (this.#disposed || this.#failed) return;
    this.#stdout += chunk;
    let newline: number;
    while ((newline = this.#stdout.indexOf("\n")) !== -1) {
      const line = this.#stdout.slice(0, newline);
      this.#stdout = this.#stdout.slice(newline + 1);
      if (line.length > 65_536) {
        this.#fail(new Error("Desktop sticky note renderer sent an oversized protocol message"));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.#fail(new Error("Desktop sticky note renderer sent invalid NDJSON"));
        return;
      }
      if (message === null || typeof message !== "object" || !("event" in message)) {
        this.#fail(new Error("Desktop sticky note renderer sent an invalid protocol message"));
        return;
      }
      if (message.event === "error" && "message" in message && typeof message.message === "string") {
        this.#fail(new Error(`Desktop sticky note renderer: ${message.message}`));
        return;
      }
      if ((message.event === "restore" || message.event === "minimize") && this.#ready) {
        // The helper may have queued an action before a dialog, resize, or new
        // note replaced its scene. Never apply it to the replacement surface.
        if ("scene" in message && message.scene === this.#interactionScene && this.#frame?.visible &&
            this.#frame.minimized === (message.event === "restore")) {
          try {
            if (message.event === "restore") this.#options.onRestore();
            else this.#options.onMinimize();
          } catch (error) {
            this.#fail(error);
          }
        }
        if (this.#disposed || this.#failed) return;
        continue;
      }
      if (message.event !== "ready" || this.#ready) {
        this.#fail(new Error("Desktop sticky note renderer sent an unexpected protocol event"));
        return;
      }
      if (!("protocol" in message) || message.protocol !== 3) {
        this.#fail(new Error("Desktop sticky note renderer lacks paper double-click support; rebuild or upgrade the native helper"));
        return;
      }
      this.#ready = true;
      clearTimeout(this.#readyTimer);
      this.#readyTimer = undefined;
      try {
        this.#options.onReady();
      } catch (error) {
        this.#fail(error);
      }
      if (this.#disposed || this.#failed) return;
      this.#refresh();
    }
    if (this.#stdout.length > 65_536) this.#fail(new Error("Desktop sticky note renderer sent an oversized protocol message"));
  };

  #diagnostic(message: string): string {
    const detail = this.#stderr.trim();
    return detail ? `${message}: ${detail}` : message;
  }

  #onChildError = (error: Error): void => {
    this.#fail(error);
  };

  #onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.#fail(new Error(this.#diagnostic(`Desktop sticky note renderer exited (${signal ?? code ?? "unknown"})`)));
  };

  #onParentExit = (): void => {
    try {
      (this.#child ?? this.#stoppingChild)?.kill("SIGKILL");
    } catch {
      // The compositor may already have reaped the companion.
    }
  };

  #fail(error: unknown): void {
    if (this.#disposed || this.#failed) return;
    this.#failed = true;
    this.#ready = false;
    this.#desired = undefined;
    this.#raster = undefined;
    this.#paper = undefined;
    this.#stop();
    try {
      this.#options.onError(error);
    } catch (callbackError) {
      console.error("Sticky note desktop error handler failed:", callbackError);
    }
  }

  #stop(): void {
    clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
    this.#stdout = "";
    this.#stderr = "";
    const child = this.#child;
    this.#child = undefined;
    if (!child) {
      if (!this.#stoppingChild) process.off("exit", this.#onParentExit);
      return;
    }
    this.#stoppingChild = child;
    child.off("error", this.#onChildError);
    child.off("exit", this.#onChildExit);
    child.stdout.off("data", this.#onStdout);
    child.stderr.off("data", this.#onStderr);
    child.stdout.off("error", this.#onChildError);
    child.stderr.off("error", this.#onChildError);
    child.stdin.off("error", this.#onChildError);
    child.stdin.off("drain", this.#onDrain);
    // An unsuccessful spawn can still emit its asynchronous error after dispose.
    child.on("error", ignoreError);
    child.stdin.on("error", ignoreError);
    child.stdout.on("error", ignoreError);
    child.stderr.on("error", ignoreError);
    let killTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      clearTimeout(killTimer);
      child.off("error", ignoreError);
      child.stdin.off("error", ignoreError);
      child.stdout.off("error", ignoreError);
      child.stderr.off("error", ignoreError);
      this.#stoppingChild = undefined;
      process.off("exit", this.#onParentExit);
    };
    child.once("close", cleanup);
    try {
      child.stdin.end();
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    } catch {
      // A broken stdin or an already-exited process is normal during shutdown.
    }
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The exit/close handlers finish cleanup if the process won the race.
        }
      }, STOP_TIMEOUT_MS);
      killTimer.unref();
    }
  }
}
