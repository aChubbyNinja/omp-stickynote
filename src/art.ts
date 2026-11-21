import type { VisualFrame } from "./effects.ts";

/** A slower renderer may present an earlier pose, never a different note or activity. */
export function continuesAnimation(before?: VisualFrame, after?: VisualFrame): boolean {
  return !!before?.motion && before.motion === after?.motion && before.fun === after.fun &&
    before.attention === after.attention && before.crew === after.crew && before.stamp === after.stamp &&
    before.dnd === after.dnd && before.checks === after.checks;
}

/** Only fields that can change visible ink belong in renderer cache keys. */
export function visualFrameKey(fx?: VisualFrame): string {
  if (!fx) return "";
  const dnd = fx.dnd ?? "";
  if (!fx.fun || dnd) return fx.motion === "crumple" ? `${dnd}/crumple/${fx.step}` : dnd;
  if (fx.attention === "waiting" && fx.motion !== "crumple") {
    // The waiting paper is steady: pulse frames and hidden crew/stamps have no visible ink.
    const motion = fx.motion === "pulse" ? undefined : fx.motion;
    return `waiting/${motion ?? ""}/${motion ? fx.step : ""}/${motion === "check" || motion === "victory" ? fx.checks.join(",") : ""}`;
  }
  return `${dnd}/${fx.attention}/${fx.crew}/${fx.stamp ?? ""}/${fx.motion ?? ""}/${fx.motion ? fx.step : ""}/${fx.motion === "check" || fx.motion === "victory" ? fx.checks.join(",") : ""}`;
}

/** Frame changes affect ANSI ink only when there's something new to show. */
export function effectLabels(fx?: VisualFrame): readonly string[] {
  if (!fx) return [];
  const labels: string[] = [];
  if (fx.dnd) labels.push(`DO NOT DISTURB — ${fx.dnd}`);
  if (fx.motion === "crumple") labels.push("Paper crumpled — a fresh start");
  if (!fx.fun || fx.dnd) return labels;
  if (fx.attention === "waiting" && fx.motion !== "crumple") return ["ANSWER NEEDED"];
  if (fx.motion === "victory" || fx.motion === "turnDone") {
    const sparks = ["* . +", ". + *", "+ * ."];
    labels.push(`${fx.motion === "victory" ? "SHIPPED!" : "TURN DONE!"}  ${sparks[fx.step % 3]}  ${sparks[(fx.step + 1) % 3]}`);
  }
  const status = ({ idle: "Ready", working: "WORKING", waiting: "Your turn", finished: "Finished" })[fx.attention];
  const crew = ({ none: "", working: "👷 ⚒ 👷", editing: "👷 ⚒ 👷  Editing", build: "👷 ⚒ 👷  Building", test: "👷 ⚗ 👷  Testing", pass: "👷 ⚑ 👷  Passed", fail: "👷 ⚑ 👷  Failed" })[fx.crew];
  labels.push(crew ? `${status}   ${crew}` : status);
  if (fx.stamp) labels.push(fx.stamp);
  if (fx.motion === "wave") labels.push("Office wave received");
  if (fx.motion === "flutter") labels.push("A little paper flutter");
  return labels;
}

export function semanticFrameKey(fx?: VisualFrame): string {
  return effectLabels(fx).join("\n");
}

/** Reserve only the rows that have visible status or crew artwork. */
export function paperRailHeight(fx?: VisualFrame): number {
  if (!fx?.fun || fx.dnd) return 0;
  if (fx.attention === "waiting" && fx.motion !== "crumple") return 0;
  return fx.crew === "none" ? 52 : 76 + (fx.stamp ? 36 : 0);
}

function lettering(text: string, x: number, y: number, size: number, fill: string, extra = ""): string {
  return `<text x="${x}" y="${y}" font-family="DejaVu Sans Mono, Noto Sans Mono, monospace" font-size="${size}" font-weight="700" fill="${fill}" ${extra}>${text}</text>`;
}

function worker(x: number, y: number, pose: number, partner: boolean, flag: boolean): string {
  const ink = "#433429";
  const hat = partner ? "#27a29a" : "#ffae29";
  const coat = partner ? "#166d70" : "#db5728";
  const face = partner ? "#ad6946" : "#f3bc86";
  const swing = [-24, -42, -12, 18, 2, -16][pose];
  const lift = [0, -2, -3, 0, 1, 0][pose];
  const tool = flag
    ? `<path d="M18 -25 v24" stroke="${ink}" stroke-width="3"/><path d="M19 -26 l20 4 -6 5 4 4 -18 -3 Z" fill="#ef664d"/>`
    : partner
      ? `<g transform="rotate(-10 15 -16)"><rect x="9" y="-27" width="20" height="21" rx="2" fill="#83d7db" stroke="${ink}" stroke-width="2"/><path d="M12 -22 h11 v6 h-6 v6" fill="none" stroke="#24546b" stroke-width="2"/></g>`
      : `<g transform="rotate(${swing} 13 -15)"><path d="M8 -10 l14 -17" stroke="${ink}" stroke-width="5"/><path d="m14 -29 7 -5 13 10 -5 6 Z" fill="#497a92" stroke="${ink}" stroke-width="2"/></g>`;
  return `<g transform="translate(${x} ${y + lift}) scale(${partner ? -1 : 1} 1)" stroke-linecap="round" stroke-linejoin="round">
<path d="m-7 -3 -3 10 h-6 m22 -10 4 10 h7" fill="none" stroke="${ink}" stroke-width="6"/>
<path d="M-12 -23 Q0 -28 11 -22 l4 21 q-14 7 -29 0 Z" fill="${coat}" stroke="${ink}" stroke-width="2.5"/>
<path d="m-7 -22 4 18 m9 -18 -3 19" fill="none" stroke="#fff0a2" stroke-width="3.5"/>
<path d="m-11 -18 -8 9 5 3 m23 -14 7 6" stroke="${ink}" stroke-width="5" fill="none"/>
<rect x="-12" y="-44" width="26" height="23" rx="9" fill="${face}" stroke="${ink}" stroke-width="2"/>
<path d="M-15 -38 q1 -15 14 -16 13 -1 16 14 l4 3 -35 3 Z" fill="${hat}" stroke="${ink}" stroke-width="2.5"/>
<path d="m-3 -52 1 8" stroke="#ffeba6" stroke-width="3"/>
${partner ? `<rect x="-7" y="-36" width="21" height="8" rx="3" fill="#acedef" stroke="${ink}" stroke-width="2"/><path d="m1 -34 -2 4 m10 -5 -2 4" stroke="white" stroke-width="2"/>` : `<path d="M-2 -33 v2 m10 -3 v2" stroke="${ink}" stroke-width="3"/>`}
<path d="M3 -26 q4 3 7 -2" fill="none" stroke="${ink}" stroke-width="2"/>${tool}</g>`;
}

function crewArt(fx: VisualFrame, width: number, height: number, step: number): string {
  if (fx.crew === "none") return "";
  const y = height - 14;
  const x = width - 182;
  const color = fx.crew === "fail" ? "#bc4b36" : fx.crew === "pass" ? "#397754" : "#df8d36";
  const beam = `<path d="M${x - 101} ${y + 11} h200" stroke="#956224" stroke-width="4" stroke-linecap="round"/>`;
  const scene = fx.crew === "build"
    ? `<g fill="#bd7945" stroke="#85532b" stroke-width="1"><rect x="${x - 8}" y="${y - 9}" width="24" height="11"/><rect x="${x + 18}" y="${y - 9}" width="24" height="11"/><rect x="${x + 4}" y="${y - 21}" width="24" height="11"/></g><path d="M${x + 13} ${y - 30} l${step % 2 ? 4 : -4} -6" stroke="#b58438" stroke-width="2"/>`
    : fx.crew === "test"
      ? `<path d="M${x + 5} ${y - 30} v12 l-10 17 h29 l-10 -17 v-12" fill="#c6e0cc" stroke="#436651" stroke-width="2"/><path d="M${x} ${y - 7} h19" stroke="#548968" stroke-width="4"/><circle cx="${x + 9}" cy="${y - 14 - step * 2}" r="2" fill="#548968"/>`
      : fx.crew === "editing"
        ? `<g transform="translate(${x - 14} ${y - 32})"><rect width="48" height="32" rx="3" fill="#faedbe" stroke="#655139" stroke-width="2"/><path d="m14 8 -7 7 7 7 m19 -14 7 7 -7 7 m-7 -17 -6 20" stroke="#397754" stroke-width="3" fill="none"/></g>`
        : fx.crew === "working"
          ? `<g transform="translate(${x - 17} ${y - 32})"><rect x="1" y="3" width="42" height="29" rx="6" fill="#53899a" stroke="#433429" stroke-width="2.5"/><rect x="7" y="8" width="30" height="15" rx="4" fill="#183d43"/><path d="M14 13 v3 m14 -3 v3" stroke="#9df4d3" stroke-width="4"/><path d="M22 2 v-7" stroke="#433429" stroke-width="2"/><circle cx="22" cy="-7" r="4" fill="#f26749"/></g>`
          : lettering(fx.crew === "pass" ? "PASS" : "FAIL", x + 9, y - 9, 15, color, 'text-anchor="middle"');
  const sparks = fx.crew === "working" || fx.crew === "editing" || fx.crew === "build"
    ? `<g transform="translate(${x - 31} ${y - 30}) rotate(${step * 6 - 12})" fill="none" stroke="#bb4926" stroke-width="3" stroke-linecap="round"><path d="m-2 -7 -4 -6 m9 5 2 -8 m5 14 6 -4"/></g>` : "";
  return `<g>${beam}${scene}${worker(x - 65, y, step, false, false)}${worker(x + 73, y, (step + 2) % 6, true, fx.crew === "pass" || fx.crew === "fail")}${sparks}</g>`;
}

export function paperArt(fx: VisualFrame | undefined, width: number, height: number): {
  ornaments: string; overlay: string; transform: string; opacity: number; foldout: string; foldoutHeight: number;
} {
  let ornaments = "";
  let overlay = "";
  let transform = "";
  let opacity = 1;
  let foldout = "";
  let foldoutHeight = 0;
  const step = Math.max(0, Math.min(5, Math.floor(fx?.step ?? 0)));
  if (fx?.dnd) {
    const x = 24;
    const y = height + 6;
    const w = width - 88;
    const build = fx.dnd === "WAITING ON A BUILD";
    const h = build ? 178 : 128;
    const mode = build
      ? lettering("WAITING ON", x + w / 2, y + 74, 50, "#3f3017") + lettering("A BUILD", x + w / 2, y + 126, 50, "#3f3017")
      : lettering("DEEP WORK", x + w / 2, y + 74, 52, "#3f3017");
    foldoutHeight = h + 6;
    foldout = `<path d="M${x + 10} ${y} H${x + w} v${h} l-18 -12 H${x} V${y + 10} Z" fill="#000" opacity="0.12" transform="translate(3 5)"/><path d="M${x + 10} ${y} H${x + w} v${h} l-18 -12 H${x} V${y + 10} Z" fill="#edc653" stroke="#a17a24"/><path d="M${x + 10} ${y} l-10 10 h10 Z M${x + w - 18} ${y + h - 12} l18 12 v-12 Z" fill="#c69b38"/><path d="M${x + 20} ${y + 14} H${x + w - 20}" stroke="#fff2a3"/><g text-anchor="middle">${mode}${lettering("DO NOT DISTURB", x + w / 2, y + h - 20, 18, "#674d25")}</g>`;
  }
  if (!fx || ((!fx.fun || fx.dnd) && fx.motion !== "crumple")) return { ornaments, overlay, transform, opacity, foldout, foldoutHeight };
  if (fx.fun && !fx.dnd) {
    const waiting = fx.attention === "waiting" && fx.motion !== "crumple";
    const right = width - 64;
    const curl = fx.motion === "flutter" || fx.motion === "wave" ? [22, 38, 52, 43, 30, 22][step] : 22;
    ornaments += `<path d="M${right - curl} ${height + 5} Q${right + 8} ${height + 12} ${right + 8} ${height - curl}" fill="${waiting ? "#315d85" : "#9d8132"}" opacity="0.18"/><path d="M${right - curl} ${height + 5} Q${right - 5} ${height - 4} ${right + 8} ${height - curl} Q${right - curl - 1} ${height - curl + 4} ${right - curl} ${height + 5} Z" fill="url(#curl)" stroke="${waiting ? "#599bc2" : "#d6b453"}" stroke-width="0.7"/>`;
    if (!waiting) {
      const attention = ({ idle: "READY", working: "WORKING", waiting: "YOUR TURN", finished: "FINISHED" })[fx.attention];
      const color = ({ idle: "#49452e", working: "#24533c", waiting: "#87401f", finished: "#24534b" })[fx.attention];
      const railY = fx.crew === "none" ? height - 44 : height - 55;
      const badgeWidth = attention.length * 16 + 70;
      const badge = fx.attention === "working"
        ? `<path d="M0 0 H${badgeWidth - 12} l12 20 -12 20 H0 Z"/>`
        : fx.attention === "waiting"
          ? `<path d="M10 0 H${badgeWidth - 10} l10 10 v20 l-10 10 H10 L0 30 V10 Z"/>`
          : `<rect width="${badgeWidth}" height="40" rx="${fx.attention === "finished" ? 20 : 6}"/>`;
      const icon = ({
        idle: '<circle cx="23" cy="20" r="10"/><path d="M18 20 h10"/>',
        working: '<path d="M14 10 h18 M14 30 h18 M16 10 l14 20 M30 10 L16 30"/>',
        waiting: '<path d="M23 10 v12 M23 29 v0.1" stroke-width="4"/>',
        finished: '<path d="M13 20 l7 7 13 -15" stroke-width="3"/>',
      })[fx.attention];
      ornaments += `<g transform="translate(32 ${railY})"><g fill="${color}">${badge}</g><g fill="none" stroke="#fff9de" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}${fx.motion === "pulse" ? `<circle cx="23" cy="20" r="${[14, 16, 18, 17, 15, 14][step]}" opacity="0.45"/>` : ""}</g>${lettering(attention, 49, 29, 26, "#fff9de")}</g>`;
      if (fx.stamp) {
        const stampWidth = fx.stamp.length * 10 + 24;
        const stampY = fx.crew === "none" ? railY + 6 : height - 108;
        ornaments += `<g transform="translate(${right - stampWidth - 7} ${stampY}) rotate(-4 ${stampWidth / 2} 15)" opacity="0.9"><rect width="${stampWidth}" height="30" rx="3" fill="none" stroke="#85553d" stroke-width="2"/><rect x="3" y="3" width="${stampWidth - 6}" height="24" rx="2" fill="none" stroke="#85553d" stroke-width="0.7"/>${lettering(fx.stamp, stampWidth / 2, 21, 16, "#85553d", 'text-anchor="middle"')}</g>`;
      }
      ornaments += crewArt(fx, width, height, fx.motion ? step : 0);
    }
    if (fx.motion === "flutter" || fx.motion === "wave") {
      const angle = [0, -1.1, 1.4, -0.8, 0.5, 0][step];
      transform = `rotate(${angle} ${width / 2 - 24} 12) translate(0 ${[0, -3, -5, -3, -1, 0][step]})`;
      if (fx.motion === "wave") {
        const radius = 10 + step * 5;
        ornaments += `<g fill="none" stroke="#6c9b85" stroke-width="2" opacity="${(6 - step) / 8}"><circle cx="${width - 98}" cy="${height - 25}" r="${radius}"/><circle cx="${width - 98}" cy="${height - 25}" r="${radius + 10}"/></g>`;
      }
    }
    if (!waiting && (fx.motion === "victory" || fx.motion === "turnDone")) {
      const colors = ["#be5946", "#4d8b75", "#bd8a24", "#7074a1"];
      for (let i = 0; i < 24; i++) {
        const x = 15 + ((i * 79 + step * (i % 2 ? 9 : -7) + width) % (width - 65));
        const y = 5 + ((i * 37 + step * 23) % Math.max(30, height - 5));
        overlay += `<rect x="${x}" y="${y}" width="${i % 3 ? 5 : 8}" height="${i % 3 ? 10 : 4}" rx="1" fill="${colors[i % colors.length]}" transform="rotate(${i * 23 + step * 31} ${x} ${y})" opacity="0.85"/>`;
      }
      const checklist = fx.motion === "victory";
      overlay += `<g transform="translate(${width / 2 - 184} ${height / 2 - 29}) rotate(-10 160 32)" opacity="${[0.45, 0.75, 1, 1, 0.9, 0.75][step]}"><rect width="320" height="72" rx="7" fill="#fff0a1" fill-opacity="0.94" stroke="#8a4938" stroke-width="5"/><rect x="7" y="7" width="306" height="58" rx="3" fill="none" stroke="#8a4938" stroke-width="1.5"/>${lettering(checklist ? "SHIPPED" : "TURN DONE", 160, 53, checklist ? 51 : 44, "#8a4938", 'text-anchor="middle" letter-spacing="3"')}</g>`;
    }
  }
  if (fx.motion === "crumple") {
    const scale = [1, 0.87, 0.65, 0.4, 0.18, 0][step];
    transform = `translate(${width / 2} ${height / 2 + step * 8}) rotate(${[0, -5, 11, -17, 26, 42][step]}) scale(${scale} ${scale * (1 - step * 0.055)}) translate(${-width / 2} ${-height / 2})`;
    opacity = step === 5 ? 0 : 1;
    if (step > 0) ornaments += `<g fill="none" stroke="#ac8d3f" stroke-width="${step}" opacity="0.4"><path d="M8 5 L${width * 0.52} ${height * 0.48} L${width - 48} 5 M8 ${height} L${width * 0.52} ${height * 0.48} L${width - 48} ${height} M${width * 0.52} 5 L${width * 0.4} ${height * 0.7} L${width * 0.75} ${height}"/></g>`;
    if (step >= 2) {
      const x = width / 2 - 24 + (step - 2) * 10;
      const y = height / 2 + [0, 0, 0, 16, 52, 108][step];
      overlay += `<g transform="translate(${x} ${Math.min(height - 2, y)})" opacity="${step === 2 ? 0.35 : 1}"><ellipse cy="35" rx="32" ry="7" fill="#5b4e26" opacity="0.14"/><g transform="rotate(${step * 29})"><path d="M-28 -12 l14 -18 21 -5 21 18 5 22 -15 24 -27 3 -23 -18 Z" fill="url(#curl)" stroke="#b39546" stroke-width="1.5"/><path d="M-28 -12 l24 7 -10 -25 M-4 -5 l11 -30 8 29 18 11 M15 -6 l-10 22 -24 16 2 -24 -11 -20 M5 16 l13 13 M-4 -5 l9 21" fill="none" stroke="#b39546" stroke-width="2"/><path d="M-22 -10 l17 7 -5 16 M10 -22 l4 14 13 9" fill="none" stroke="#fff3ad" stroke-width="3"/></g></g>`;
    }
  }
  return { ornaments, overlay, transform, opacity, foldout, foldoutHeight };
}
