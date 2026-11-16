import { truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { cleanLabel, type Note } from "./state.ts";

export const WELCOME = "Your project and next steps will appear here.";

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

/** A fixed design canvas; terminal geometry scales the complete paper, not individual labels. */
export function paperSvg(note: Note): { svg: string; width: number; height: number } {
  const width = 520;
  const ink: string[] = [];
  // Monospace metrics make a terminal-cell wrap conservative even for CJK and emoji fallback fonts.
  const lines = (label: string, size: number, available: number) => wrapLabel(label, 2, available / (size * 0.66));
  const text = (label: string, x: number, y: number, size: number, weight: number, color = "#292616") => {
    ink.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${xml(label)}</text>`);
  };
  const title = lines(note.title.toUpperCase(), 36, 436);
  ink.push('<g text-anchor="middle">');
  title.forEach((line, index) => text(line, 256, 62 + index * 44, 36, 800));
  ink.push("</g>");
  let y = 62 + (title.length - 1) * 44 + 48;
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
  const height = Math.max(206, y + 26);
  const paperHeight = height - 26;
  // Layered translucent silhouettes soften the offset shadow without a blur filter dependency.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>
  <linearGradient id="paper" x1="0" y1="0" x2="0.3" y2="1"><stop stop-color="#fff1a0"/><stop offset="0.48" stop-color="#ffe780"/><stop offset="1" stop-color="#f7dc69"/></linearGradient>
  <clipPath id="ink"><rect x="30" y="20" width="452" height="${paperHeight - 24}"/></clipPath>
</defs>
<rect x="9" y="15" width="505" height="${paperHeight + 2}" rx="19" fill="#000" opacity="0.025"/>
<rect x="11" y="16" width="501" height="${paperHeight}" rx="17" fill="#000" opacity="0.035"/>
<rect x="13" y="15" width="497" height="${paperHeight - 1}" rx="15" fill="#000" opacity="0.045"/>
<rect x="14" y="13" width="493" height="${paperHeight - 1}" rx="13" fill="#000" opacity="0.055"/>
<rect x="8" y="5" width="496" height="${paperHeight}" rx="13" fill="url(#paper)" stroke="#fff3b2" stroke-opacity="0.65"/>
<path d="M23 6 H489" stroke="#fff9d2" stroke-opacity="0.7"/>
<g font-family="DejaVu Sans Mono, Noto Sans Mono, monospace" clip-path="url(#ink)">${ink.join("")}</g>
</svg>`;
  return { svg, width, height };
}
