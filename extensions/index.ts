// zsh-bang-complete
//
// Autocompletion + suggestions for pi's `!` / `!!` bash command input,
// powered by the user's zsh + oh-my-zsh configuration.
//
// What it provides while the editor line starts with `!` (or `!!`):
//   1. Command-position completion using the *interactive* zsh environment,
//      so oh-my-zsh aliases (gst, gco, ...), shell functions, builtins and
//      everything on $PATH show up — exactly what `zsh -i` knows about.
//   2. History suggestions from ~/.zsh_history (most-recent-first, de-duped),
//      mimicking zsh-autosuggestions: type a prefix and the full historic
//      command line is offered as the top suggestion.
//   3. File / path completion for argument positions.
//
// Everything else falls through to pi's built-in slash / path autocomplete.

import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

const MAX_SUGGESTIONS = 25;
const MAX_HISTORY_SUGGESTIONS = 8;
const HISTORY_PATH = process.env.HISTFILE || join(homedir(), ".zsh_history");

type BangContext = {
	/** Length of the leading bang prefix ("!" or "!!"). */
	bangLen: number;
	/** Text typed after the bang prefix, up to the cursor. */
	commandText: string;
	/** The token currently being typed (text after the last whitespace). */
	currentToken: string;
	/** Whether the cursor is on the first (command) token. */
	isCommandPosition: boolean;
};

/** Parse the editor line into a bang-command context, or null if not a bang line. */
function parseBang(line: string, cursorCol: number): BangContext | null {
	if (!line.startsWith("!")) return null;
	const bangLen = line.startsWith("!!") ? 2 : 1;
	const beforeCursor = line.slice(0, cursorCol);
	if (beforeCursor.length < bangLen) return null;
	const commandText = beforeCursor.slice(bangLen);
	const currentToken = /(\S*)$/.exec(commandText)?.[1] ?? "";
	const head = commandText.slice(0, commandText.length - currentToken.length);
	const isCommandPosition = head.trim() === "";
	return { bangLen, commandText, currentToken, isCommandPosition };
}

/** Load command names known to an interactive zsh (loads ~/.zshrc + oh-my-zsh). */
async function loadZshCommands(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	try {
		const result = await pi.exec(
			"zsh",
			[
				"-i",
				"-c",
				"print -rl -- ${(ko)commands} ${(ko)aliases} ${(ko)galiases} ${(ko)functions} ${(ko)builtins} ${(ko)reswords} 2>/dev/null",
			],
			{ cwd, timeout: 10_000 },
		);
		const names = new Set<string>();
		for (const raw of result.stdout.split("\n")) {
			const name = raw.trim();
			// Skip oh-my-zsh internal helpers and noise.
			if (!name || name.startsWith("_") || name.includes(" ")) continue;
			names.add(name);
		}
		return [...names].sort();
	} catch {
		return [];
	}
}

/** Load ~/.zsh_history as most-recent-first, de-duplicated command lines. */
async function loadZshHistory(): Promise<string[]> {
	let raw: string;
	try {
		raw = await readFile(HISTORY_PATH, "utf8");
	} catch {
		return [];
	}
	const seen = new Set<string>();
	const out: string[] = [];
	const lines = raw.split("\n");
	// Extended history format: ": <timestamp>:<duration>;<command>"
	for (let i = lines.length - 1; i >= 0; i--) {
		let cmd = lines[i] ?? "";
		const meta = /^: \d+:\d+;(.*)$/.exec(cmd);
		if (meta) cmd = meta[1] ?? "";
		cmd = cmd.trim();
		if (!cmd || seen.has(cmd)) continue;
		seen.add(cmd);
		out.push(cmd);
	}
	return out;
}

/** File / path completion for the current argument token, relative to cwd. */
async function fileCompletions(
	token: string,
	cwd: string,
	signal: AbortSignal,
): Promise<AutocompleteItem[]> {
	let base = token;
	let prefixDir = "";
	const slash = token.lastIndexOf("/");
	if (slash >= 0) {
		prefixDir = token.slice(0, slash + 1);
		base = token.slice(slash + 1);
	}

	let lookupDir = prefixDir;
	if (lookupDir.startsWith("~")) {
		lookupDir = lookupDir.replace(/^~(?=\/|$)/, homedir());
	}
	const absDir = isAbsolute(lookupDir) ? lookupDir : resolve(cwd, lookupDir || ".");

	let entries: string[];
	try {
		entries = await readdir(absDir);
	} catch {
		return [];
	}
	if (signal.aborted) return [];

	const matches = entries
		.filter((name) => name.startsWith(base) && (base.startsWith(".") || !name.startsWith(".")))
		.sort();

	const items: AutocompleteItem[] = [];
	for (const name of matches.slice(0, MAX_SUGGESTIONS)) {
		let isDir = false;
		try {
			isDir = (await stat(join(absDir, name))).isDirectory();
		} catch {
			/* ignore */
		}
		const value = `${prefixDir}${name}${isDir ? "/" : ""}`;
		items.push({ value, label: value, description: isDir ? "dir" : "file" });
	}
	return items;
}

function createBangProvider(
	current: AutocompleteProvider,
	cwd: string,
	getCommands: () => Promise<string[]>,
	getHistory: () => Promise<string[]>,
): AutocompleteProvider {
	return {
		triggerCharacters: ["!"],

		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const bang = parseBang(line, cursorCol);
			if (!bang) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const { commandText, currentToken, isCommandPosition } = bang;

			if (isCommandPosition) {
				// Command position: prefix === currentToken === commandText.
				const [commands, history] = await Promise.all([getCommands(), getHistory()]);
				if (options.signal.aborted) return null;

				const items: AutocompleteItem[] = [];

				// History suggestions (zsh-autosuggestions style): full command lines.
				const histMatches = commandText
					? history.filter((h) => h.startsWith(commandText) && h !== commandText)
					: history;
				for (const h of histMatches.slice(0, MAX_HISTORY_SUGGESTIONS)) {
					items.push({ value: h, label: h, description: "history" });
				}

				// Command / alias / function / builtin completion.
				const cmdMatches = currentToken
					? fuzzyFilter(commands, currentToken, (c) => c)
					: [];
				for (const c of cmdMatches.slice(0, MAX_SUGGESTIONS - items.length)) {
					if (!items.some((it) => it.value === c)) {
						items.push({ value: c, label: c, description: "command" });
					}
				}

				if (items.length === 0) return null;
				return { items, prefix: currentToken };
			}

			// Argument position: file / path completion.
			const items = await fileCompletions(currentToken, cwd, options.signal);
			if (options.signal.aborted || items.length === 0) return null;
			return { items, prefix: currentToken };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			// Replace the `prefix` immediately before the cursor with item.value.
			const start = cursorCol - prefix.length;
			if (start < 0 || line.slice(start, cursorCol) !== prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			const newLine = line.slice(0, start) + item.value + line.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: start + item.value.length,
			};
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const line = lines[cursorLine] ?? "";
			if (line.startsWith("!")) {
				// We own completion for bang lines; suppress built-in @/path triggering.
				return false;
			}
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		let commandsPromise: Promise<string[]> | undefined;
		const getCommands = () => (commandsPromise ||= loadZshCommands(pi, ctx.cwd));

		// History is cheap and changes between commands; reload with a short TTL.
		let historyPromise: Promise<string[]> | undefined;
		let historyAt = 0;
		const getHistory = () => {
			if (!historyPromise || Date.now() - historyAt > 3_000) {
				historyAt = Date.now();
				historyPromise = loadZshHistory();
			}
			return historyPromise;
		};

		// Warm caches.
		void getCommands();
		void getHistory();

		ctx.ui.addAutocompleteProvider((current) =>
			createBangProvider(current, ctx.cwd, getCommands, getHistory),
		);
	});
}
