import type { Note } from "./state.ts";

export interface VisualFrame {
  fun: boolean;
  attention: "idle" | "working" | "waiting" | "finished";
  crew: "none" | "working" | "editing" | "build" | "test" | "pass" | "fail";
  stamp?: "FIRST COMMIT" | "TESTS PASSED" | "RELEASED";
  dnd?: "DEEP WORK" | "WAITING ON A BUILD";
  motion?: "victory" | "turnDone" | "flutter" | "crumple" | "wave" | "check" | "pulse";
  step: number;
  checks: readonly number[];
}

type Motion = NonNullable<VisualFrame["motion"]>;
const EMPTY_CHECKS: readonly number[] = Object.freeze([]);
const MOTIONS: Record<Motion, { priority: number; steps: number }> = {
  pulse: { priority: 0, steps: 4 },
  check: { priority: 1, steps: 6 },
  flutter: { priority: 2, steps: 6 },
  wave: { priority: 3, steps: 6 },
  turnDone: { priority: 3, steps: 6 },
  victory: { priority: 4, steps: 6 },
  crumple: { priority: 5, steps: 6 },
};
const FRAME_MS = 120;
const CREW_MS = 2400;
const STAMP_MS = 4200;

/** Session-local effects with finite motion and a held, truthful completion frame. */
export class Effects {
  #changed: () => void;
  #crumpled: () => void;
  #disposed = false;
  #fun = false;
  #dnd: VisualFrame["dnd"];
  #attention: VisualFrame["attention"] = "idle";
  #crew: VisualFrame["crew"] = "none";
  #stamp: VisualFrame["stamp"];
  #motion: VisualFrame["motion"];
  #step = 0;
  #checks: readonly number[] = EMPTY_CHECKS;
  #completion?: "victory" | "turnDone";
  #previous?: Note;
  #animation?: NodeJS.Timeout;
  #crewTimer?: NodeJS.Timeout;
  #stampTimer?: NodeJS.Timeout;
  #frame?: VisualFrame;

  constructor(changed: () => void, crumpled: () => void) {
    this.#changed = changed;
    this.#crumpled = crumpled;
  }

  get frame(): VisualFrame {
    const active = this.#active;
    return this.#frame ??= {
      fun: this.#fun,
      attention: active ? this.#attention : "idle",
      crew: active ? this.#visibleCrew : "none",
      stamp: active ? this.#stamp : undefined,
      dnd: this.#dnd,
      motion: this.#motion,
      step: this.#step,
      checks: this.#checks,
    };
  }

  get #active(): boolean {
    return this.#fun && !this.#dnd && !this.#disposed;
  }

  get #visibleCrew(): VisualFrame["crew"] {
    if (this.#crew !== "none") return this.#crew;
    return this.#attention === "working" || this.#motion === "turnDone" ? "working" : "none";
  }

  fun(on: boolean): void {
    if (this.#disposed || this.#fun === on) return;
    this.#fun = on;
    if (!on) this.#quiet();
    else this.#restoreCompletion();
    this.#notify();
  }

  dnd(mode: VisualFrame["dnd"]): void {
    if (this.#disposed || this.#dnd === mode) return;
    this.#dnd = mode;
    if (mode) this.#quiet();
    else this.#restoreCompletion();
    // Returning from quiet shows current completion without replaying its animation.
    this.#notify();
  }

  note(note: Note, baseline = false): void {
    if (this.#disposed) return;
    const previous = this.#previous;
    const tasksChanged = !previous || previous.tasks.length !== note.tasks.length ||
      previous.tasks.some((task, i) => task.id !== note.tasks[i].id || task.text !== note.tasks[i].text || task.done !== note.tasks[i].done);
    const changed = tasksChanged || previous?.title !== note.title;
    const progress = note.progress;
    const oldProgress = previous?.progress;
    const progressChanged = progress?.length !== oldProgress?.length ||
      progress?.some((task, i) => task.id !== oldProgress?.[i]?.id || task.done !== oldProgress?.[i]?.done);
    if (!changed && !progressChanged && !baseline) return;
    this.#previous = {
      title: note.title, tasks: note.tasks.map(task => ({ ...task })),
      progress: progressChanged ? progress?.map(task => ({ ...task })) : oldProgress,
    };
    if (baseline) {
      // Restore/show cancels dismissal, but must not erase a still-current completion.
      if (tasksChanged || progressChanged) this.#clearCompletion();
      const checks = this.#completion ? this.#checks : EMPTY_CHECKS;
      this.#stopMotion();
      this.#restoreCompletion();
      if (this.#active && this.#completion) this.#checks = checks;
      this.#notify();
      return;
    }
    if (!previous) return;
    const sameTitle = previous.title === note.title;
    const used = new Set<number>();
    const checks: number[] = [];
    if (sameTitle || (oldProgress && progress)) {
      for (let i = 0; i < note.tasks.length; i++) {
        const task = note.tasks[i];
        if (!task.done) continue;
        // Match occurrences, not indexes: the host may remove completed rows or reorder work.
        const old = previous.tasks.findIndex((candidate, index) =>
          !used.has(index) && candidate.id === task.id && candidate.text === task.text && candidate.done === task.done);
        const unfinished = old < 0 ? previous.tasks.findIndex((candidate, index) =>
          !used.has(index) && candidate.id === task.id && candidate.text === task.text && !candidate.done) : -1;
        if (old >= 0) used.add(old);
        else if (unfinished >= 0) {
          used.add(unfinished);
          checks.push(i);
        }
      }
    }
    let finished = false;
    if (oldProgress && progress) {
      // The final three checked rows need not include any of the previously visible open rows.
      if (oldProgress.some(t => !t.done) && progress.length && progress.every(t => t.done)) {
        const completed = new Set(progress.map(t => t.id));
        finished = oldProgress.every(t => t.done || (t.id !== undefined && completed.has(t.id)));
      }
    } else if (sameTitle && !oldProgress && !progress) {
      finished = previous.tasks.some(task => !task.done) && note.tasks.length > 0 &&
        note.tasks.every(task => task.done) && previous.tasks.every((task, index) => task.done || used.has(index));
    }
    if (!changed && !progressChanged && !finished) return;
    // Generated titles and repeated projections are not new work.
    if (!tasksChanged && !progressChanged && this.#completion) return;
    if (!finished) this.#clearCompletion();
    // Suppressed checklist cues are not queued; only an already-shown victory is held.
    if (finished && this.#active && this.#attention !== "waiting" && this.#motion !== "crumple") {
      this.#completion = "victory";
    }
    if (!this.#active || this.#attention === "waiting") return;
    if (this.#motion !== "crumple" && (!sameTitle || this.#motion === "turnDone" || (this.#motion === "victory" && !finished))) {
      this.#stopMotion();
    }
    if (this.#motion !== "crumple" && checks.length) this.#checks = Object.freeze(checks);
    if (finished) this.#startMotion("victory");
    else if (checks.length) this.#startMotion("check");
    else this.#startMotion("flutter");
    this.#notify();
  }

  attention(value: VisualFrame["attention"]): void {
    if (this.#disposed || this.#attention === value) return;
    const wasWorking = this.#attention === "working";
    this.#attention = value;
    if (value === "working" || value === "waiting" || value === "idle") this.#clearCompletion();
    else if (wasWorking && !this.#completion && this.#motion !== "crumple") this.#completion = "turnDone";
    if (!this.#active) return;
    if (this.#motion === "pulse" || this.#motion === "flutter" || this.#motion === "turnDone") this.#stopMotion();
    if (value === "working") this.#startMotion("flutter");
    else if (value === "waiting") this.#startMotion("pulse");
    else if (value === "finished" && this.#completion === "turnDone") this.#startMotion("turnDone");
    this.#notify();
  }

  crew(value: VisualFrame["crew"]): void {
    if (this.#disposed) return;
    if (this.#crew === value) {
      if (value === "editing") { clearTimeout(this.#crewTimer); this.#crewTimer = undefined; }
      return;
    }
    if (value !== "none" && value !== "pass") this.#clearCompletion();
    const linger = this.#active && this.#crew === "editing" && value === "none";
    if (linger && this.#crewTimer) return;
    clearTimeout(this.#crewTimer);
    this.#crewTimer = undefined;
    if (!linger) this.#crew = value;
    if (!this.#active) {
      if (value === "pass" || value === "fail") this.#crew = "none";
      return;
    }
    if (linger || value === "pass" || value === "fail") {
      this.#crewTimer = setTimeout(() => {
        this.#crewTimer = undefined;
        this.#crew = "none";
        this.#notify();
      }, CREW_MS);
      this.#crewTimer.unref?.();
      if (!linger) this.#startMotion(value === "pass" ? "check" : "flutter");
    } else if (value !== "none") {
      this.#startMotion("flutter");
    }
    this.#notify();
  }

  milestone(value: NonNullable<VisualFrame["stamp"]>): void {
    if (!this.#active || this.#stamp === value) return;
    clearTimeout(this.#stampTimer);
    this.#stamp = value;
    this.#stampTimer = setTimeout(() => {
      this.#stampTimer = undefined;
      this.#stamp = undefined;
      this.#notify();
    }, STAMP_MS);
    this.#stampTimer.unref?.();
    this.#notify();
  }

  wave(): void {
    if (!this.#active || !this.#startMotion("wave")) return;
    this.#notify();
  }

  crumple(): void {
    if (this.#disposed || !this.#startMotion("crumple")) return;
    this.#completion = undefined;
    this.#notify();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#quiet();
    this.#stopMotion();
    this.#previous = undefined;
    this.#frame = undefined;
  }

  #notify(): void {
    const frame = this.#frame;
    const active = this.#active;
    if (frame && frame.fun === this.#fun && frame.dnd === this.#dnd &&
      frame.attention === (active ? this.#attention : "idle") &&
      frame.crew === (active ? this.#visibleCrew : "none") &&
      frame.stamp === (active ? this.#stamp : undefined) &&
      frame.motion === this.#motion && frame.step === this.#step &&
      frame.checks.length === this.#checks.length &&
      frame.checks.every((row, index) => row === this.#checks[index])) return;
    // Invalidate before rendering: a synchronous callback must see the new snapshot.
    this.#frame = undefined;
    this.#changed();
  }

  #quiet(): void {
    // Quiet hides effects, not the current completion. Reopening paints it settled.
    if (this.#crewTimer) this.#crew = "none";
    clearTimeout(this.#crewTimer);
    clearTimeout(this.#stampTimer);
    this.#crewTimer = undefined;
    this.#stampTimer = undefined;
    this.#stamp = undefined;
    if (this.#motion !== "crumple") this.#stopMotion();
  }

  #clearCompletion(): void {
    this.#completion = undefined;
    if (this.#motion === "victory" || this.#motion === "turnDone") this.#stopMotion();
  }

  #restoreCompletion(): void {
    if (!this.#active || !this.#completion || this.#motion === "crumple") return;
    this.#motion = this.#completion;
    this.#step = MOTIONS[this.#completion].steps - 1;
  }

  #stopMotion(): void {
    clearInterval(this.#animation);
    this.#animation = undefined;
    this.#motion = undefined;
    this.#step = 0;
    this.#checks = EMPTY_CHECKS;
  }

  #startMotion(motion: Motion): boolean {
    if (this.#motion && MOTIONS[this.#motion].priority >= MOTIONS[motion].priority) return false;
    clearInterval(this.#animation);
    // Completion has no expiry: only real state changes can clear its final frame.
    this.#motion = motion;
    this.#step = 0;
    if (motion === "crumple") this.#checks = EMPTY_CHECKS;
    const confetti = motion === "victory" || motion === "turnDone";
    this.#animation = setInterval(() => {
      if (this.#step + 1 >= MOTIONS[motion].steps) {
        if (confetti) {
          clearInterval(this.#animation);
          this.#animation = undefined;
          return; // Hold the last painted frame without scheduling more repaints.
        }
        this.#stopMotion();
        this.#notify();
        if (motion === "crumple" && !this.#disposed) this.#crumpled();
      } else {
        this.#step++;
        this.#notify();
      }
    }, FRAME_MS);
    this.#animation.unref?.();
    return true;
  }
}
