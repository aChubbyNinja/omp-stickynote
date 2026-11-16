# Changelog

## 1.1.2 — 2026-11-16

- Remove OMP's decorative icon/tag prefix from automatic headlines, retaining the meaningful title and leaving manual titles untouched.
- Increase native headline type from 36 to 48 units (33%) with extra-heavy weight and a subtle strengthening stroke; keep task typography unchanged.
- Halve the native graphic's top gap within the terminal viewport using cell-aware spacing. ANSI fallback moves to the top row because text terminals cannot position half rows.
- Add regression coverage for decorated session titles and ordinary titles containing colons.

## 1.1.1 — 2026-11-16

- Center the headline and display it in all caps for better distance readability, in both native graphics and ANSI output.
- Keep task checkbox alignment, label casing, typography, and spacing unchanged.

## 1.1.0 — 2026-11-16

- Replace the automatic working-directory title and empty checkbox with **Ready to begin** and a short welcome until real session details arrive.
- Start at the top-right, then move once to the top-center after transcript scrolling; reset placement for a new session.
- Add host-native SVG rasterization for graphics-capable terminals: a larger, heavier title, prominent task labels, softened yellow paper, and a subtle shadow.
- Adapt the note to available width and height, up to roughly 54 columns, while retaining a readable ANSI fallback.
- Add host-backed text and SIXEL regression coverage, including safe image placement and stale-raster invalidation.

Host compatibility: OMP 18.21.0; no new external runtime dependencies. Graphics output verified in Foot/SIXEL on Linux/Wayland. Plain ANSI cannot enlarge individual fonts. Restart existing OMP sessions to load the update.

## 1.0.0 — 2026-11-16

- Add a persistent yellow, top-right sticky note with a bold project title and one to three task checkboxes.
- Follow OMP session titles and todo snapshots automatically, including completed work and user task-board edits.
- Add `/sticky` controls and the agent-callable `sticky_note` tool for manual notes.
- Restore note preferences from the active session branch; keep typing focus in the composer.
- Support terminal resizing, Unicode-aware wrapping, safe labels, and cached rendering.
- Include MIT licensing, installation and compatibility guidance, and state edge-case tests.

Host compatibility: OMP 18.21.0. ANSI terminal rendering verified on Linux/Wayland with tmux.
