# Changelog

## 1.4.2 — 2026-11-20

- Fixed frame starvation on slower desktop and terminal graphics paths: a finished frame is now shown even if the next pose is already queued. Frames from an old note, activity, or size are still discarded.
- Fixed missed confetti when OMP completed more tasks than the three displayed on the card. The note observes live todo results, tracks the full checklist, and holds its final confetti frame for a visible 3.6-second celebration.
- The construction crew now appears for ordinary file edits and writes, including quick operations. Recognized foreground build/test chains also bring out the workers; editing alone never produces a passing-test stamp.

## 1.4.1 — 2026-11-20

- Local paper effects now start enabled unless the current branch has a saved preference. Use `/sticky boring mode` to turn them off and `/sticky fun on` to turn them back on. Office sharing remains opt-in.

## 1.4.0 — 2026-11-17

### Paper effects and office features

1. **SHIPPED** and confetti when the note's remaining tasks become complete under the same title; this is a task celebration, not evidence of publication.
2. Curled paper corners and brief flutter on note/activity changes.
3. Varied handwritten checkbox strokes with brief draw-on completion marks.
4. `/sticky crumple` dismissal and `/sticky show` restoration without deleting the note.
5. Main-session attention badges for ready, working, waiting for input/approval, and finished.
6. A construction crew for recognized foreground build/test tool calls and their pass/fail results.
7. **FIRST COMMIT**, **TESTS PASSED**, and **RELEASED** stamps tied to supported actual command results, never title/prompt text. Release stamps additionally require final publication evidence.
8. A larger **DEEP WORK** / **WAITING ON A BUILD** fold-out DND sign, controlled by `/sticky dnd`, `/sticky dnd build`, `/sticky dnd off`, or Ctrl+Alt+D. Set `OMP_STICKY_DND_SHORTCUT=off` before starting OMP to leave the shortcut unbound.
9. Explicitly enabled LAN office sharing and a live, read-only mission-control board of peer projects, tasks, and attention states. Arrow keys scroll; Escape or q closes the board without stopping sharing.
10. Brief peer waves from recognized successful releases, without wave retransmission.

Local fun effects default off and are enabled with `/sticky fun on`; DND, crumple, and LAN sharing remain separate explicit actions. ANSI fallback provides readable status labels. Activity recognition is limited to monitored OMP main-session direct foreground `bash` calls, not arbitrary shells, scripts, CI, subagents, or background jobs.

Office requires one privately shared 32-byte random group key and each machine's actual LAN IPv4 interface. It uses AES-256-GCM multicast at **239.255.77.80:47831/UDP**, **TTL 1**, with no cloud service. Key holders are a trusted group, not individually authenticated identities; titles/tasks may be sensitive and removing a member requires key rotation. Hiding, crumpling, session exit/switch, and branch navigation stop sharing; unclean departures expire after 20 seconds. Fun off, DND, and closing the board do not stop sharing.

Update privacy guidance: the normal note and local effects make no network requests, but opt-in office mode sends encrypted LAN snapshots and release waves. Retain the existing install/update commands, saved note compatibility, bundled Linux x86-64 companion, and terminal fallback.

### Reliability and compatibility

- Recover from transient Hyprland IPC snapshot failures with bounded retries; keep the desktop surface hidden while ownership/visibility state is invalid.
- Tested with **Foot and OMP 18.22.2** on Hyprland. Office transport was tested with **two loopback sessions**, not two physical computers; physical two-machine LAN behavior is not verified for this release.

## 1.3.0 — 2026-11-16

- Publish as `omp-sticky`, enabling the short installation command `omp install omp-sticky`.
- Bundle the Linux x86-64 desktop companion so current Omarchy installations no longer need a source checkout or compiler.
- Select the companion by platform and architecture, retaining source builds, PATH discovery, and explicit terminal fallback.
- Build and version-check the native executable during packaging; do not rely on dependency installation hooks.
- Preserve saved note state when migrating from the previous `omp-stickynote` installation.

## 1.2.1 — 2026-11-16

- Keep startup and fitting titles at the existing width; widen centered graphic cards only when needed to avoid title truncation.
- Expand evenly left and right by up to 33% of the original paper width per side, with a two-row title limit and ellipsis at the cap.
- Preserve headline/task font sizes and task wrapping; restore the compact width when the title fits again.
- Cover fitting, minimal expansion, viewport limits, maximum width, and ellipsis in the host-backed layout regression.
- Rebuild the native version metadata when packaging a version-only companion update.

## 1.2.0 — 2026-11-16

- Add an optional Linux/Hyprland desktop companion that keeps the note fixed during native terminal scrollback, without placing sticky-note images in terminal history.
- Increase headline type from 48 to 72 design units (50%), retaining the task typography.
- Replace the layered hard shadow with a blurred alpha shadow and balanced transparent gutters; the desktop backend no longer erases a rectangular area around the note.
- Follow the owning terminal's process ancestry, geometry, workspace, and visibility with a click-through, non-focusable Qt Quick layer-shell surface.
- Preserve terminal-only rendering on unsupported setups, with explicit setup/failure notices and `OMP_STICKY_RENDERER=terminal` opt-out.
- Add companion build/package scripts and deterministic ownership, placement, workspace, and occlusion coverage.

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
