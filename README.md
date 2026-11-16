# OMP Stickynote

**Know what your terminal is working on—from across the room.**

A small yellow sticky note pinned to the top-right of an [Oh My Pi](https://github.com/can1357/oh-my-pi) terminal session. Bold project title. One to three task checkboxes. Always in the live viewport, never in the way of typing.

![OMP Stickynote pinned above scrolling terminal output](assets/terminal.png)

## Install

Requires **OMP 18.21.0**. This is an OMP extension, not a desktop widget or a plugin for other tools named Pi.

```sh
git clone https://github.com/aChubbyNinja/omp-stickynote.git
cd omp-stickynote
omp install .
```

Start a new `omp` session. No build, npm install, API key, or desktop configuration is needed. Keep the checkout in place: local installation links to it. Update with `git pull`, then restart OMP.

Try it without installing:

```sh
omp -e /absolute/path/to/omp-stickynote/src/index.ts
```

Remove it with `omp plugin uninstall omp-stickynote`, then restart OMP.

## How it works

- **Automatic by default.** Uses the session title, falling back to the working directory name before the session has a title. Follows the first three unfinished OMP todos in plan order. Once everything is complete, shows up to three completed tasks.
- **Visible immediately.** Before tasks exist, displays one empty checkbox. The note stays pinned while output scrolls and while the agent works or waits.
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

- Yellow paper (`#FFE76A`), dark text (`#231F10`), and a bold title; independent of your OMP theme.
- 38 terminal columns wide; roughly logo-sized with short labels. Long titles and tasks wrap to two lines, then truncate. Terminal resize clamps the overlay to the available space.
- Text uses your terminal's font size. Increase terminal zoom for greater across-the-room readability.
- This is a **floating overlay**, not reserved layout space: it covers output beneath it. `/sticky hide` reveals that output. Native scrollback and full-screen dialogs belong to the terminal/host; the note is pinned to the live OMP viewport, not those separate surfaces. Very short panes may clip it.
- Interactive ANSI TUI only. Print, JSON, RPC, and subagent sessions do not mount the note.
- Tested against OMP **18.21.0** on Linux/Wayland, including a real terminal inside tmux. Other OMP releases and native Tern rendering are not verified.

OMP 18.21.0 has no dedicated passive-overlay option. A small compatibility seam in `src/index.ts` uses the TUI's exposed overlay stack and `released` flag to retain editor focus. Changes to that host contract may require an extension update.

## Development

Node.js 24+ is needed for development only. Runtime dependencies are supplied by OMP.

```sh
npm ci --ignore-scripts
npm run check
npm test
omp --no-extensions -e ./src/index.ts
```

`src/state.ts` handles safe labels and branch-local restoration. `src/note.ts` renders width-aware, cached ANSI rows. `src/index.ts` owns the overlay lifecycle and commands. Tests exercise terminal escape sanitization, task selection, failed/cleared snapshots, and session isolation. Run the checks above before submitting changes; hosted CI is not configured.

Before changing host integration, verify a real OMP session: type while the note is visible, scroll output, resize, hide/show, open a new session, and restore a saved session. Never publish screenshots containing private session content.

Contributions and reproducible bug reports are welcome. Include your OMP version, terminal, operating system, and reproduction steps. Do not attach API keys or private transcripts. For a sensitive report, use [GitHub private vulnerability reporting](https://github.com/aChubbyNinja/omp-stickynote/security/advisories/new).

## License

[MIT](LICENSE). Independent community project; not affiliated with or endorsed by Oh My Pi.
