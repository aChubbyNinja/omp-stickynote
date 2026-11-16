# OMP Stickynote

**Keep your project and next steps in view.**

A yellow sticky note for an [Oh My Pi](https://github.com/can1357/oh-my-pi) terminal session, with a prominent project title and up to three task checkboxes. It starts at the top-right, then moves to the top-center as transcript output begins scrolling.

![OMP Stickynote pinned above scrolling terminal output](assets/terminal.png)

The welcome state stays quiet until there is real work to display:

![OMP Stickynote welcoming a new session](assets/welcome.png)

## Install

Requires **OMP 18.21.0**. This is an OMP extension, not a desktop widget or a plugin for other tools named Pi.

```sh
git clone https://github.com/aChubbyNinja/omp-stickynote.git
cd omp-stickynote
omp install .
```

Start a new `omp` session. No build, npm install, API key, or desktop configuration is needed. Keep the checkout in place: local installation links to it. Update with `git pull`, then restart OMP; existing sessions do not pick up source changes automatically.

Try it without installing:

```sh
omp -e /absolute/path/to/omp-stickynote/src/index.ts
```

Remove it with `omp plugin uninstall omp-stickynote`, then restart OMP.

## How it works

- **Automatic by default.** Uses the session title and follows the first three unfinished OMP todos in plan order. Once everything is complete, shows up to three completed tasks.
- **A clean welcome.** Before a session title or tasks exist, shows **Ready to begin** and “Your project and next steps will appear here.” No working-directory name or automatic empty checkbox.
- **Pinned to the live viewport.** Starts at the top-right and moves once to the top-center after actual transcript scrolling. A new session resets the position to the top-right.
- **Keyboard stays yours.** No key capture, editor replacement, or extra prompt to dismiss.
- **Session-local.** Manual notes and visibility are stored in OMP's session entries and restored on resume or branch navigation. Separate sessions do not share mutable note state. OMP controls persistence: a fresh session with no assistant turn may still be memory-only, and `--no-session` never saves it.
- **No extra model calls.** The extension uses OMP's existing title and task state. It makes no network requests and adds no telemetry.

## Commands

```text
/sticky Release dashboard | Finish UI | Verify checkout | Deploy
/sticky done 1
/sticky auto
/sticky hide
/sticky show
```

| Command | Effect |
| --- | --- |
| `/sticky Title \| task one \| task two \| task three` | Pin a manual title and one to three tasks. |
| `/sticky Title` | Pin a title with one empty checkbox. |
| `/sticky done N` | Toggle checkbox 1, 2, or 3 on a manual note. |
| `/sticky auto` | Return to the session title and live OMP todo list. |
| `/sticky hide` / `/sticky show` | Hide or restore the note for this session. |
| `/sticky` | Show command help. |

The `|` character separates fields; labels cannot contain it in slash commands. For those labels, ask the agent to use the `sticky_note` tool instead. The tool accepts a `title` and one to three `{ text, done }` tasks. Manual notes stay pinned until `/sticky auto`—automatic task updates do not overwrite them.

## Display and compatibility

- Warm yellow paper and dark ink, independent of your OMP theme.
- Graphics-capable terminals use host-native SVG rasterization for a substantially larger, heavier title, prominent task labels, rounded paper, and a subtle shadow. Verified in a real Foot/SIXEL terminal on Linux/Wayland.
- Plain ANSI terminals retain a readable text fallback. They cannot enlarge individual fonts; terminal zoom controls text size. Across-the-room readability still depends on terminal size and viewing distance.
- Up to roughly 54 terminal columns wide, clamped to the available width and height rather than a fixed-size box. Long labels wrap and truncate to fit.
- Rendered graphics are not selectable text for copying. The ANSI fallback uses terminal text.
- This is a **floating overlay**, not reserved layout space: it covers output beneath it. `/sticky hide` reveals that output. Native scrollback and full-screen dialogs belong to the terminal/host; the note is pinned to the live OMP viewport, not those separate surfaces.
- Interactive TUI only. Print, JSON, RPC, and subagent sessions do not mount the note.
- Targets OMP **18.21.0**, with no new external runtime dependencies. Plain ANSI rendering was also verified inside tmux. Other OMP releases and native Tern rendering are not verified.

OMP 18.21.0 has no dedicated passive-overlay option and its partial-overlay text slicer does not preserve SIXEL. Two small compatibility seams in `src/index.ts` use the exposed overlay stack's `released` flag to retain editor focus, and a public post-paint callback to place cached image rows over the reserved rectangle. Moving, hiding, or replacing the note clears its old graphics and requests a host repaint. Changes to those host contracts may require an extension update.

## Development

Development requires **Node.js 24+** and an installed **OMP 18.21.0** executable in `PATH`. Runtime dependencies are supplied by OMP.

```sh
npm ci --ignore-scripts
npm run check
npm test
omp --no-extensions -e ./src/index.ts
```

`src/state.ts` handles safe labels and branch-local restoration. `src/paper.ts` defines the card's typography and SVG layout. `src/note.ts` renders cached graphics or width-aware ANSI rows. `src/index.ts` owns the overlay lifecycle and commands. Tests exercise terminal escape sanitization, task selection, failed/cleared snapshots, session isolation, and host-backed rendering. `npm test` finds the installed OMP host rather than npm's dependency-local Bun CLI; set `OMP_BIN=/absolute/path/to/omp` to select an executable explicitly. The host-backed test checks text fallback and native SIXEL generation, including keeping image controls out of the text compositor. Actual placement is verified separately in Foot. Hosted CI is not configured.

Before changing host integration, verify a real OMP session: type while the note is visible, generate enough output to check its position change, resize, hide/show, open a new session to check the reset, and restore a saved session. Check graphics in a compatible terminal such as Foot/SIXEL and the plain-text fallback separately. Never publish screenshots containing private session content.

Contributions and reproducible bug reports are welcome. Include your OMP version, terminal, operating system, and reproduction steps. Do not attach API keys or private transcripts. For a sensitive report, use [GitHub private vulnerability reporting](https://github.com/aChubbyNinja/omp-stickynote/security/advisories/new).

## License

[MIT](LICENSE). Independent community project; not affiliated with or endorsed by Oh My Pi.
