# pi-zsh-bang-complete

A [pi](https://pi.dev) package that supercharges pi's `!` / `!!` bash command
input with autocompletion and history suggestions powered by **your** zsh +
oh-my-zsh configuration.

## What it does

While the editor line starts with `!` or `!!`, this extension provides:

1. **Command completion via oh-my-zsh** — runs `zsh -i -c` (loading your full
   `~/.zshrc`), so your oh-my-zsh aliases (`gst`, `gco`, `ll`, …), shell
   functions, builtins and everything on `$PATH` appear as completions. Matching
   is fuzzy.
2. **History suggestions (zsh-autosuggestions style)** — reads `~/.zsh_history`
   (extended format supported), most-recent-first and de-duplicated. Type a
   prefix and the full historic command line is offered as the top suggestion.
3. **File / path completion** for argument positions, relative to the current
   working directory.

Anything that isn't a `!` line falls through to pi's built-in slash-command and
path autocomplete.

## Install

```bash
# from npm (once published)
pi install npm:pi-zsh-bang-complete

# or straight from git
pi install git:github.com/<you>/pi-zsh-bang-complete

# project-local (shared with your team via .pi/settings.json)
pi install -l git:github.com/<you>/pi-zsh-bang-complete

# try it without installing
pi -e ./path/to/pi-zsh-bang-complete
```

After installing, run `/reload` in a pi session (or restart pi), then type `!`
followed by a command to see completions and suggestions.

## Requirements

- `zsh` available on `$PATH` (oh-my-zsh optional but recommended).
- TUI mode (the extension is a no-op in print/json/rpc modes).
- Reads `$HISTFILE` if set, otherwise `~/.zsh_history`.

## Notes

- The command list is loaded once per session and cached.
- History is reloaded with a short (3s) TTL so recent commands show up.

## What this extension reads and runs (transparency)

This extension runs entirely locally. It never opens a network connection and
never transmits any data — there are no `fetch`, `http`, `socket`, or
`child_process` calls.

| Action | Detail | Notes |
|--------|--------|-------|
| Reads `~/.zsh_history` (or `$HISTFILE`) | Powers history suggestions | Local only; shown solely in your own editor, never sent anywhere |
| Runs `zsh -i -c 'print -rl ...'` | Loads your `~/.zshrc` / oh-my-zsh to list commands, aliases and functions | Executes your own shell config; the command is fixed and does not interpolate your typed input |
| `readdir` / `stat` in the working directory | File / path completion | Local only |

The call to `zsh` uses **fixed arguments** and never concatenates the text you
type, so there is no shell-injection surface.

## License

MIT
