import { truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { cleanLabel, type Note } from "./state.ts";

export const WELCOME = "Your project and next steps will appear here.";
export const PAPER_WIDTH = 560;
export const MAX_PAPER_WIDTH = PAPER_WIDTH + 496 * 0.66;
const TITLE_ADVANCE = 72 * 0.66;

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

/** Terminal geometry scales the paper; title growth adds space without changing typography. */
export function paperSvg(note: Note, rowHeight = 0, maxWidth = MAX_PAPER_WIDTH): { svg: string; width: number; height: number } {
  const headline = headlineLayout(note.title, maxWidth);
  const width = headline.width;
  const extra = width - PAPER_WIDTH;
  // Replace the former full terminal-row margin with half its visible gap,
  // including the paper's existing five-unit inset. ANSI stays on whole rows.
  const topInset = Math.max(0, (rowHeight - 5) / 2);
  const ink: string[] = [];
  // Monospace metrics make a terminal-cell wrap conservative even for CJK and emoji fallback fonts.
  const lines = (label: string, size: number, available: number) => wrapLabel(label, 2, available / (size * 0.66));
  const text = (label: string, x: number, y: number, size: number, weight: number, color = "#292616") => {
    ink.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${xml(label)}</text>`);
  };
  const title = headline.lines;
  ink.push('<g text-anchor="middle" stroke="#292616" stroke-width="0.6" stroke-linejoin="round" paint-order="stroke fill">');
  title.forEach((line, index) => text(line, 256 + extra / 2, 92 + index * 86, 72, 900));
  ink.push("</g>");
  let y = 92 + (title.length - 1) * 86 + 48;
  if (note.tasks.length === 0) {
    const welcome = lines(WELCOME, 20, 436);
    welcome.forEach((line, index) => text(line, 36, y + index * 29, 20, 400, "#645b32"));
    y += welcome.length * 29;
  } else {
    for (const task of note.tasks.slice(0, 3)) {
      const label = lines(task.text, 24, 400);
      ink.push(`<rect x="36" y="${y - 20}" width="23" height="23" rx="5" fill="${task.done ? "#e4cb65" : "#fff1a1"}" stroke="#6d6031" stroke-width="2"/>`);
      if (task.done) ink.push(`<path d="M42 ${y - 9} l5 5 8 -10" fill="none" stroke="#38351e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`);
      label.forEach((line, index) => text(line, 76, y + index * 32, 24, 600));
      y += label.length * 32 + 18;
    }
  }
  const paperHeight = Math.max(206, y + 26) - 26;
  const height = paperHeight + 74 + topInset;
  // Preserve alpha and leave room for the complete blur instead of clipping a hard rectangle.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>
  <linearGradient id="paper" x1="0" y1="0" x2="0.3" y2="1"><stop stop-color="#fff1a0"/><stop offset="0.48" stop-color="#ffe780"/><stop offset="1" stop-color="#f7dc69"/></linearGradient>
  <clipPath id="ink"><rect x="30" y="20" width="${452 + extra}" height="${paperHeight - 24}"/></clipPath>
  <filter id="shadow" x="-10%" y="-15%" width="120%" height="140%" color-interpolation-filters="sRGB">
    <feGaussianBlur stdDeviation="7"/>
  </filter>
</defs>
<g transform="translate(24 ${24 + topInset})">
<rect x="8" y="13" width="${496 + extra}" height="${paperHeight}" rx="13" fill="#000" opacity="0.16" filter="url(#shadow)"/>
<rect x="8" y="5" width="${496 + extra}" height="${paperHeight}" rx="13" fill="url(#paper)" stroke="#fff3b2" stroke-opacity="0.65"/>
<path d="M23 6 H${489 + extra}" stroke="#fff9d2" stroke-opacity="0.7"/>
<g font-family="DejaVu Sans Mono, Noto Sans Mono, monospace" clip-path="url(#ink)">${ink.join("")}</g>
</g>
</svg>`;
  return { svg, width, height };
}
