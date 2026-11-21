import { truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { paperArt, paperRailHeight } from "./art.ts";
import type { VisualFrame } from "./effects.ts";
import { cleanLabel, type Note } from "./state.ts";

export const WELCOME = "Your project and next steps will appear here.";
export const PAPER_WIDTH = 560;
export const MAX_PAPER_WIDTH = PAPER_WIDTH + 496 * 0.66;
const TITLE_ADVANCE = 72 * 0.66;
const TICKS = ["l5 5 8 -10", "l4 6 10 -12", "l6 4 8 -11"];

/** Grow only enough to fit two title rows; never shrink the type to fit a title. */
export function headlineLayout(title: string, maxWidth = MAX_PAPER_WIDTH): { width: number; lines: readonly string[] } {
  const label = cleanLabel(title).toUpperCase();
  const ceiling = Math.max(PAPER_WIDTH, Math.min(MAX_PAPER_WIDTH, maxWidth));
  let columns = Math.floor(436 / TITLE_ADVANCE);
  let lines = wrapTextWithAnsi(label, columns);
  if (lines.length <= 2) return { width: PAPER_WIDTH, lines };
  const maxColumns = Math.floor((436 + ceiling - PAPER_WIDTH) / TITLE_ADVANCE);
  while (lines.length > 2 && columns < maxColumns) {
    lines = wrapTextWithAnsi(label, ++columns);
  }
  const width = lines.length > 2 ? ceiling : PAPER_WIDTH + columns * TITLE_ADVANCE - 436;
  return {
    width,
    lines: lines.length <= 2 ? lines : [lines[0], truncateToWidth(lines.slice(1).join(" "), columns)],
  };
}

export function wrapLabel(text: string, limit: number, available: number): string[] {
  available = Math.max(1, Math.floor(available));
  const lines = wrapTextWithAnsi(cleanLabel(text), available);
  if (lines.length > limit) {
    return [...lines.slice(0, limit - 1), truncateToWidth(lines.slice(limit - 1).join(" "), available)];
  }
  return lines.length ? [...lines] : [""];
}

function xml(text: string): string {
  return cleanLabel(text)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\uFFFE|\uFFFF/gu, "\uFFFD")
    .replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

/** The opaque paper body in SVG coordinates; shadows and foldout gutters are not paper. */
export interface PaperShape {
  x: number;
  y: number;
  width: number;
  height: number;
  transform: string;
  visible: boolean;
}

/** Terminal geometry scales the paper; title growth adds space without changing typography. */
export function paperSvg(note: Note, rowHeight = 0, maxWidth = MAX_PAPER_WIDTH, fx?: VisualFrame): { svg: string; width: number; height: number; paper: PaperShape } {
  const headline = headlineLayout(note.title, maxWidth);
  const width = headline.width;
  const extra = width - PAPER_WIDTH;
  const waiting = !!fx?.fun && !fx.dnd && fx.attention === "waiting" && fx.motion !== "crumple";
  const inkColor = waiting ? "#10264b" : "#292616";
  const answerSize = waiting ? Math.min(64, Math.floor((436 + extra) / (13 * 0.66))) : 0;
  const contentOffset = waiting ? answerSize + 44 : 0;
  // Replace the former full terminal-row margin with half its visible gap,
  // including the paper's existing five-unit inset. ANSI stays on whole rows.
  const topInset = Math.max(0, (rowHeight - 5) / 2);
  const ink: string[] = [];
  // Monospace metrics make a terminal-cell wrap conservative even for CJK and emoji fallback fonts.
  const lines = (label: string, size: number, available: number) => wrapLabel(label, 2, available / (size * 0.66));
  const text = (label: string, x: number, y: number, size: number, weight: number, color = inkColor) => {
    ink.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${xml(label)}</text>`);
  };
  const title = headline.lines;
  if (waiting) {
    ink.push(`<text x="${256 + extra / 2}" y="${30 + answerSize}" font-size="${answerSize}" font-weight="900" fill="${inkColor}" text-anchor="middle">ANSWER NEEDED</text>`);
    ink.push(`<path d="M36 ${contentOffset + 10} H${472 + extra}" stroke="#10264b" stroke-opacity="0.25" stroke-width="2"/>`);
  }
  ink.push(`<g text-anchor="middle" stroke="${inkColor}" stroke-width="0.6" stroke-linejoin="round" paint-order="stroke fill">`);
  title.forEach((line, index) => text(line, 256 + extra / 2, contentOffset + 92 + index * 86, 72, 900));
  ink.push("</g>");
  let y = contentOffset + 92 + (title.length - 1) * 86 + 48;
  if (note.tasks.length === 0) {
    const welcome = lines(WELCOME, 20, 436);
    welcome.forEach((line, index) => text(line, 36, y + index * 29, 20, 400, waiting ? "#294c70" : "#645b32"));
    y += welcome.length * 29;
  } else {
    for (const [index, task] of note.tasks.slice(0, 3).entries()) {
      const label = lines(task.text, 24, 400);
      ink.push(`<rect x="36" y="${y - 20}" width="23" height="23" rx="5" fill="${waiting ? task.done ? "#70b4d6" : "#c4e9f7" : task.done ? "#e4cb65" : "#fff1a1"}" stroke="${waiting ? "#294c70" : "#6d6031"}" stroke-width="2"/>`);
      if (task.done) {
        const drawing = fx?.fun && !fx.dnd && (fx.motion === "check" || fx.motion === "victory") && fx.checks.includes(index);
        const progress = drawing ? (Math.max(0, Math.min(5, fx.step)) + 1) / 6 : 1;
        ink.push(`<path d="M42 ${y - 9} ${fx?.fun && !fx.dnd ? TICKS[index] : TICKS[0]}" fill="none" stroke="${waiting ? "#10264b" : "#38351e"}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"${drawing ? ` stroke-dasharray="24" stroke-dashoffset="${24 * (1 - progress)}"` : ""}/>`);
      }
      label.forEach((line, index) => text(line, 76, y + index * 32, 24, 600));
      y += label.length * 32 + 18;
    }
  }
  const paperHeight = Math.max(206, y + 26) - 26 + paperRailHeight(fx);
  const art = paperArt(fx, width, paperHeight);
  const height = paperHeight + 74 + topInset + art.foldoutHeight;
  // Preserve alpha and leave room for the complete blur instead of clipping a hard rectangle.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>
  <linearGradient id="paper" x1="0" y1="0" x2="0.3" y2="1"><stop stop-color="${waiting ? "#b7e5f6" : "#fff1a0"}"/><stop offset="0.48" stop-color="${waiting ? "#87ceeb" : "#ffe780"}"/><stop offset="1" stop-color="${waiting ? "#74bbdd" : "#f7dc69"}"/></linearGradient>
  <linearGradient id="curl" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${waiting ? "#5197bd" : "#e0ba4f"}"/><stop offset="0.42" stop-color="${waiting ? "#d0f0fc" : "#fff3ad"}"/><stop offset="1" stop-color="${waiting ? "#68acd0" : "#e4c15d"}"/></linearGradient>
  <clipPath id="ink"><rect x="30" y="20" width="${452 + extra}" height="${paperHeight - 24}"/></clipPath>
  <filter id="shadow" x="-10%" y="-15%" width="120%" height="140%" color-interpolation-filters="sRGB">
    <feGaussianBlur stdDeviation="7"/>
  </filter>
</defs>
<g transform="translate(24 ${24 + topInset})">
<g${art.transform ? ` transform="${art.transform}"` : ""}${art.opacity !== 1 ? ` opacity="${art.opacity}"` : ""}>
<rect x="8" y="13" width="${496 + extra}" height="${paperHeight}" rx="13" fill="#000" opacity="0.16" filter="url(#shadow)"/>
<rect x="8" y="5" width="${496 + extra}" height="${paperHeight}" rx="13" fill="url(#paper)" stroke="${waiting ? "#d0f0fc" : "#fff3b2"}" stroke-opacity="0.65"/>
<path d="M23 6 H${489 + extra}" stroke="${waiting ? "#e6f7ff" : "#fff9d2"}" stroke-opacity="0.7"/>
<g font-family="DejaVu Sans Mono, Noto Sans Mono, monospace" clip-path="url(#ink)">${ink.join("")}</g>
${art.ornaments}${art.foldout}
</g>
${art.overlay}
</g>
</svg>`;
  return {
    svg, width, height,
    paper: { x: 24, y: 24 + topInset, width: 496 + extra, height: paperHeight, transform: art.transform, visible: art.opacity > 0 && fx?.motion !== "crumple" },
  };
}
