import type { Note } from "./state.ts";

export interface VisualFrame {
  fun: boolean;
  attention: "idle" | "working" | "waiting" | "finished";
  crew: "none" | "build" | "test" | "pass" | "fail";
  stamp?: "FIRST COMMIT" | "TESTS PASSED" | "RELEASED";
  dnd?: "DEEP WORK" | "WAITING ON A BUILD";
  motion?: "victory" | "flutter" | "crumple" | "wave" | "check" | "pulse";
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
  victory: { priority: 4, steps: 6 },
  crumple: { priority: 5, steps: 6 },
};
const FRAME_MS = 120;
const CREW_MS = 2400;
const STAMP_MS = 4200;

/** Session-local, finite effects. Saved notes and their task objects are never retained. */
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
      crew: active ? this.#crew : "none",
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

  fun(on: boolean): void {
    if (this.#disposed || this.#fun === on) return;
    this.#fun = on;
    if (!on) this.#quiet();
    this.#notify();
  }

  dnd(mode: VisualFrame["dnd"]): void {
    if (this.#disposed || this.#dnd === mode) return;
    this.#dnd = mode;
    if (mode) this.#quiet();
    // Returning from DND shows current steady activity, never old celebrations.
    this.#notify();
  }

  note(note: Note, baseline = false): void {
    if (this.#disposed) return;
    const previous = this.#previous;
    const changed = !previous || previous.title !== note.title || previous.tasks.length !== note.tasks.length ||
      previous.tasks.some((task, i) => task.text !== note.tasks[i]?.text || task.done !== note.tasks[i]?.done);
    if (!changed && !baseline) return;
    this.#previous = { title: note.title, tasks: note.tasks.map(task => ({ ...task })) };
    if (baseline) {
      // Explicit restore/show is also the cancellation boundary for a pending dismissal.
      const hadMotion = this.#motion !== undefined;
      this.#stopMotion();
      if (hadMotion) this.#notify();
      return;
    }
    if (!previous || !this.#active) return;
    const sameTitle = previous.title === note.title;
    const used = new Set<number>();
    const checks: number[] = [];
    if (sameTitle) {
      for (let i = 0; i < note.tasks.length; i++) {
        const task = note.tasks[i];
        if (!task.done) continue;
        // Match occurrences, not indexes: the host may remove completed rows or reorder work.
        const old = previous.tasks.findIndex((candidate, index) =>
          !used.has(index) && candidate.text === task.text && candidate.done === task.done);
        const unfinished = old < 0 ? previous.tasks.findIndex((candidate, index) =>
          !used.has(index) && candidate.text === task.text && !candidate.done) : -1;
        if (old >= 0) used.add(old);
        else if (unfinished >= 0) {
          used.add(unfinished);
          checks.push(i);
        }
      }
    }
    const finished = sameTitle && previous.tasks.some(task => !task.done) && note.tasks.length > 0 &&
      note.tasks.every(task => task.done) &&
      previous.tasks.every((task, index) => task.done || used.has(index));
    if (this.#motion !== "crumple" && (!sameTitle || (this.#motion === "victory" && !finished))) {
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
    this.#attention = value;
    if (!this.#active) return;
    if (this.#motion === "pulse" || this.#motion === "flutter") this.#stopMotion();
    if (value === "working") this.#startMotion("flutter");
    else if (value === "waiting") this.#startMotion("pulse");
    this.#notify();
  }

  crew(value: VisualFrame["crew"]): void {
    if (this.#disposed || this.#crew === value) return;
    clearTimeout(this.#crewTimer);
    this.#crewTimer = undefined;
    this.#crew = value;
    if (!this.#active) {
      if (value === "pass" || value === "fail") this.#crew = "none";
      return;
    }
    if (value === "pass" || value === "fail") {
      this.#crewTimer = setTimeout(() => {
        this.#crewTimer = undefined;
        this.#crew = "none";
        this.#notify();
      }, CREW_MS);
      this.#crewTimer.unref?.();
      this.#startMotion(value === "pass" ? "check" : "flutter");
    } else if (value === "build" || value === "test") {
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
      frame.crew === (active ? this.#crew : "none") &&
      frame.stamp === (active ? this.#stamp : undefined) &&
      frame.motion === this.#motion && frame.step === this.#step &&
      frame.checks.length === this.#checks.length &&
      frame.checks.every((row, index) => row === this.#checks[index])) return;
    // Invalidate before rendering: a synchronous callback must see the new snapshot.
    this.#frame = undefined;
    this.#changed();
  }

  #quiet(): void {
    clearTimeout(this.#crewTimer);
    clearTimeout(this.#stampTimer);
    this.#crewTimer = undefined;
    this.#stampTimer = undefined;
    this.#stamp = undefined;
    if (this.#crew === "pass" || this.#crew === "fail") this.#crew = "none";
    if (this.#motion !== "crumple") this.#stopMotion();
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
    this.#motion = motion;
    this.#step = 0;
    if (motion === "crumple") this.#checks = EMPTY_CHECKS;
    this.#animation = setInterval(() => {
      if (++this.#step >= MOTIONS[motion].steps) {
        this.#stopMotion();
        this.#notify();
        if (motion === "crumple" && !this.#disposed) this.#crumpled();
      } else {
        this.#notify();
      }
    }, FRAME_MS);
    this.#animation.unref?.();
    return true;
  }
}
