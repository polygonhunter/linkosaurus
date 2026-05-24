import { Plugin, PluginSettingTab, App, Setting, Notice, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

interface AutoLinkSettings {
	keywordList: string;
	scanVaultLinks: boolean;
	caseInsensitive: boolean;
	scanFrontmatterAliases: boolean;
	blocklist: string;
	minKeywordLength: number;
	folderFilter: string;
	folderFilterMode: "include" | "exclude";
	periodicRelink: boolean;
	periodicRelinkIntervalMinutes: number;
	singleWordDelimiter: string;
	multiWordDelimiter: string;
}

const DEFAULT_SETTINGS: AutoLinkSettings = {
	keywordList: "",
	scanVaultLinks: true,
	caseInsensitive: true,
	scanFrontmatterAliases: true,
	blocklist: "",
	minKeywordLength: 0,
	folderFilter: "",
	folderFilterMode: "exclude",
	periodicRelink: false,
	periodicRelinkIntervalMinutes: 5,
	singleWordDelimiter: "//",
	multiWordDelimiter: "///",
};

interface KeywordEntry {
	keyword: string;
	target: string;
}

interface PendingUndo {
	from: number;
	typedText: string;
	matchedKeywordNorm: string;
	timer: number;
}

function sanitize(text: string): string {
	return text.replace(/\]\]|\[\[|[|#^\\\/\n\r\0]/g, "");
}

export default class AutoLinkKeywordsPlugin extends Plugin {
	settings: AutoLinkSettings = { ...DEFAULT_SETTINGS };
	private entries: KeywordEntry[] = [];
	private lookupMap = new Map<string, string>();
	private manualEntries: KeywordEntry[] = [];
	private manualLookup = new Map<string, string>();
	private vaultEntries: KeywordEntry[] = [];
	private blocklistSet = new Set<string>();
	private scanTimer: number | null = null;
	private saveTimer: number | null = null;
	private pendingUndo: PendingUndo | null = null;
	private relinkTimer: number | null = null;
	private relinkDebounceTimer: number | null = null;
	private relinking = false;

	async onload() {
		await this.loadSettings();
		this.parseBlocklist();
		this.parseManualKeywords();

		this.registerEditorExtension([
			EditorView.inputHandler.of(
				(
					view: EditorView,
					from: number,
					to: number,
					text: string
				) => this.handleInput(view, from, to, text)
			),
			EditorView.updateListener.of((update) => {
				if (
					this.pendingUndo &&
					update.selectionSet &&
					!update.docChanged
				) {
					this.clearPendingUndo();
				}
			}),
			EditorView.domEventHandlers({
				paste: (event: ClipboardEvent, view: EditorView) => {
					return this.handlePaste(event, view);
				},
				keydown: (event: KeyboardEvent, view: EditorView): boolean => {
					if (
						event.key === "Enter" &&
						!event.isComposing &&
						!event.ctrlKey &&
						!event.metaKey &&
						!event.altKey
					) {
						return this.handleEnterKey(view);
					}
					return false;
				},
			}),
		]);

		this.addCommand({
			id: "link-and-add-keyword",
			name: "Link selection and add to keyword list",
			editorCallback: (editor) => {
				let text = editor.getSelection();

				if (!text) {
					const cursor = editor.getCursor();
					const line = editor.getLine(cursor.line);
					let start = cursor.ch;
					let end = cursor.ch;
					while (start > 0 && !/\s/.test(line.charAt(start - 1)))
						start--;
					while (end < line.length && !/\s/.test(line.charAt(end)))
						end++;
					text = line.substring(start, end);
					if (!text) return;
					editor.setSelection(
						{ line: cursor.line, ch: start },
						{ line: cursor.line, ch: end }
					);
				}

				const cursor = editor.getCursor("from");
				const lineText = editor.getLine(cursor.line);
				const before = lineText.substring(0, cursor.ch);
				if (this.isInsideWikilink(before)) return;

				const safe = sanitize(text);
				editor.replaceSelection(`[[${safe}]]`);

				if (!this.manualLookup.has(this.normalize(text))) {
					const list = this.settings.keywordList.trimEnd();
					const sep = list ? "\n" : "";
					this.settings.keywordList = list + sep + text;
					this.saveSettings();
				}
			},
		});

		this.addCommand({
			id: "autolink-current-note",
			name: "Auto-link keywords in current note",
			editorCallback: (editor) => {
				const content = editor.getValue();
				if (content.length > 100000) {
					new Notice(
						"Note too large for auto-linking (max 100k characters)."
					);
					return;
				}
				const file = this.app.workspace.getActiveFile();
				const selfName = file?.basename ?? "";
				const replaced = this.replaceKeywordsInText(
					content,
					"",
					"",
					selfName
				);
				if (replaced === content) {
					new Notice("No keywords found to link.");
					return;
				}
				const lastLine = editor.lastLine();
				const lastCh = editor.getLine(lastLine).length;
				editor.replaceRange(
					replaced,
					{ line: 0, ch: 0 },
					{ line: lastLine, ch: lastCh }
				);
				new Notice("Keywords auto-linked.");
			},
		});

		this.addCommand({
			id: "relink-all-notes",
			name: "Auto-link keywords in all notes",
			callback: () => {
				this.relinkVault(true);
			},
		});

		this.addSettingTab(new AutoLinkSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.scheduleScan();
			this.startPeriodicRelink();
		});

		this.registerEvent(
			this.app.metadataCache.on("resolved", () => this.scheduleScan())
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", () => this.scheduleScan())
		);
		this.registerEvent(
			this.app.vault.on("create", () => {
				this.scheduleScan();
				this.scheduleRelinkDebounced();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", () => this.scheduleScan())
		);
		this.registerEvent(
			this.app.vault.on("rename", () => {
				this.scheduleScan();
				this.scheduleRelinkDebounced();
			})
		);
	}

	onunload() {
		if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.stopPeriodicRelink();
		if (this.relinkDebounceTimer !== null) window.clearTimeout(this.relinkDebounceTimer);
		this.clearPendingUndo();
	}

	private normalize(text: string): string {
		return this.settings.caseInsensitive ? text.toLowerCase() : text;
	}

	private static PUNCTUATION_TRIGGERS = ").,!?:;";

	private handleInput(
		view: EditorView,
		from: number,
		to: number,
		text: string
	): boolean {
		if (!text) return false;

		if (text.length > 1) {
			return this.handleBulkInput(view, from, to, text);
		}

		if (from !== to) return false;

		if (this.pendingUndo) {
			if (/^\s+$/.test(text)) return false;
			if (AutoLinkKeywordsPlugin.PUNCTUATION_TRIGGERS.includes(text)) {
				this.clearPendingUndo();
				return false;
			}
			return this.handleUndoOnContinue(view, from, text);
		}

		if (text === " ") {
			return this.tryAutolinkBeforeCursor(view, from, " ", true);
		}

		if (AutoLinkKeywordsPlugin.PUNCTUATION_TRIGGERS.includes(text)) {
			return this.tryAutolinkBeforeCursor(view, from, text, false);
		}

		return false;
	}

	private handleEnterKey(view: EditorView): boolean {
		if (this.pendingUndo) {
			this.clearPendingUndo();
			return false;
		}

		const sel = view.state.selection.main;
		if (!sel.empty) return false;

		this.tryAutolinkBeforeCursor(view, sel.head, "", false);
		return false;
	}

	private tryAutolinkBeforeCursor(
		view: EditorView,
		pos: number,
		trailing: string,
		setupPendingUndo: boolean
	): boolean {
		const state = view.state;
		const line = state.doc.lineAt(pos);
		const colOffset = pos - line.from;
		const textBefore = line.text.substring(0, colOffset);

		if (!textBefore.length) return false;
		if (this.isInCodeContext(view, pos, line.text, colOffset)) return false;
		if (this.isInsideWikilink(textBefore)) return false;

		const alias = this.matchAlias(textBefore);
		if (alias) {
			const file = this.app.workspace.getActiveFile();
			if (file && this.normalize(alias.target) === this.normalize(file.basename))
				return false;
			const absStart = line.from + alias.start;
			const t = sanitize(alias.target);
			const d = sanitize(alias.displayText);
			const insert = `[[${t}|${d}]]${trailing}`;
			view.dispatch({
				changes: { from: absStart, to: pos, insert },
				selection: { anchor: absStart + insert.length },
			});
			return true;
		}

		const direct = this.matchKeyword(textBefore);
		if (direct) {
			const file = this.app.workspace.getActiveFile();
			if (file && this.normalize(direct.target) === this.normalize(file.basename))
				return false;
			const absStart = line.from + direct.start;
			const kw = sanitize(direct.keyword);
			const tg = sanitize(direct.target);
			const insert =
				kw.toLowerCase() === tg.toLowerCase()
					? `[[${kw}]]${trailing}`
					: `[[${tg}|${kw}]]${trailing}`;
			view.dispatch({
				changes: { from: absStart, to: pos, insert },
				selection: { anchor: absStart + insert.length },
			});

			if (setupPendingUndo) {
				const kwNorm = this.normalize(direct.keyword);
				const prefix = kwNorm + " ";
				const hasLonger = this.entries.some((e) => {
					const norm = this.normalize(e.keyword);
					return (
						norm.length > kwNorm.length && norm.startsWith(prefix)
					);
				});
				if (hasLonger) {
					this.clearPendingUndo();
					this.pendingUndo = {
						from: absStart,
						typedText: direct.typedText,
						matchedKeywordNorm: kwNorm,
						timer: window.setTimeout(
							() => (this.pendingUndo = null),
							5000
						),
					};
				}
			}

			return true;
		}

		return false;
	}

	private handleBulkInput(
		view: EditorView,
		from: number,
		to: number,
		text: string
	): boolean {
		if (this.entries.length === 0) return false;
		if (text.length > 10000) return false;

		const state = view.state;
		const line = state.doc.lineAt(from);
		const colOffset = from - line.from;
		if (this.isInCodeContext(view, from, line.text, colOffset))
			return false;

		const textBefore = line.text.substring(0, colOffset);
		if (this.isInsideWikilink(textBefore)) return false;

		const charBefore =
			from > 0 ? state.doc.sliceString(from - 1, from) : "";
		const charAfter =
			to < state.doc.length
				? state.doc.sliceString(to, to + 1)
				: "";

		const file = this.app.workspace.getActiveFile();
		const selfName = file?.basename ?? "";
		const replaced = this.replaceKeywordsInText(
			text,
			charBefore,
			charAfter,
			selfName
		);
		if (replaced === text) return false;

		if (this.pendingUndo) this.clearPendingUndo();

		view.dispatch({
			changes: { from, to, insert: replaced },
			selection: { anchor: from + replaced.length },
		});
		return true;
	}

	private handlePaste(event: ClipboardEvent, view: EditorView): boolean {
		const text = event.clipboardData?.getData("text/plain");
		if (!text || text.length > 10000) return false;
		if (this.entries.length === 0) return false;

		const state = view.state;
		const { from, to } = state.selection.main;
		const line = state.doc.lineAt(from);
		const colOffset = from - line.from;

		if (this.isInCodeContext(view, from, line.text, colOffset)) return false;
		const textBefore = line.text.substring(0, colOffset);
		if (this.isInsideWikilink(textBefore)) return false;

		const file = this.app.workspace.getActiveFile();
		const selfName = file?.basename ?? "";

		const charBefore = from > 0 ? state.doc.sliceString(from - 1, from) : "";
		const charAfter = to < state.doc.length ? state.doc.sliceString(to, to + 1) : "";

		const replaced = this.replaceKeywordsInText(text, charBefore, charAfter, selfName);
		if (replaced === text) return false;

		if (this.pendingUndo) this.clearPendingUndo();

		event.preventDefault();
		view.dispatch({
			changes: { from, to, insert: replaced },
			selection: { anchor: from + replaced.length },
		});
		return true;
	}

	private replaceKeywordsInText(
		text: string,
		charBefore: string,
		charAfter: string,
		skipKeyword?: string
	): string {
		const result: string[] = [];
		const ci = this.settings.caseInsensitive;
		const normalizedText = ci ? text.toLowerCase() : text;
		const skipNorm = skipKeyword
			? this.normalize(skipKeyword)
			: undefined;
		let i = 0;

		if (text.startsWith("---\n") || text.startsWith("---\r\n")) {
			const searchFrom = text.indexOf("\n") + 1;
			const fmCloseRegex = /\n---[ \t]*(?:\n|$)/;
			const match = fmCloseRegex.exec(text.substring(searchFrom));
			if (match) {
				const fmEnd = searchFrom + match.index + match[0].length;
				result.push(text.substring(0, fmEnd));
				i = fmEnd;
			}
		}

		while (i < text.length) {
			const sub3 = text.substring(i, i + 3);

			if (sub3 === "```" || sub3 === "~~~") {
				const closeIdx = text.indexOf(sub3, i + 3);
				if (closeIdx !== -1) {
					result.push(text.substring(i, closeIdx + 3));
					i = closeIdx + 3;
				} else {
					result.push(text.substring(i));
					i = text.length;
				}
				continue;
			}

			if (text.substring(i, i + 2) === "[[") {
				const closeIdx = text.indexOf("]]", i + 2);
				if (closeIdx !== -1) {
					result.push(text.substring(i, closeIdx + 2));
					i = closeIdx + 2;
				} else {
					result.push(text.substring(i));
					i = text.length;
				}
				continue;
			}

			if (text.charAt(i) === "[" && text.charAt(i + 1) !== "[") {
				const closeBracket = text.indexOf("]", i + 1);
				if (
					closeBracket !== -1 &&
					text.charAt(closeBracket + 1) === "("
				) {
					const parenClose = text.indexOf(
						")",
						closeBracket + 2
					);
					if (parenClose !== -1) {
						result.push(
							text.substring(i, parenClose + 1)
						);
						i = parenClose + 1;
						continue;
					}
				}
			}

			if (text.charAt(i) === "`") {
				const closeIdx = text.indexOf("`", i + 1);
				if (closeIdx !== -1) {
					result.push(text.substring(i, closeIdx + 1));
					i = closeIdx + 1;
				} else {
					result.push(text.substring(i));
					i = text.length;
				}
				continue;
			}

			const urlPrefix = normalizedText.substring(i, i + 8);
			if (
				urlPrefix.startsWith("http://") ||
				urlPrefix.startsWith("https://")
			) {
				let end = i;
				while (
					end < text.length &&
					!/\s/.test(text.charAt(end))
				)
					end++;
				result.push(text.substring(i, end));
				i = end;
				continue;
			}

			const aliasMatch = this.matchAliasInText(text, i, skipNorm);
			if (aliasMatch) {
				result.push(aliasMatch.replacement);
				i = aliasMatch.end;
				continue;
			}

			const code = text.charCodeAt(i);
			if (
				code >= 0xd800 &&
				code <= 0xdbff &&
				i + 1 < text.length
			) {
				result.push(text.substring(i, i + 2));
				i += 2;
				continue;
			}

			let prevChar: string;
			if (i === 0) {
				prevChar = charBefore;
			} else {
				const prevCode = text.charCodeAt(i - 1);
				if (
					prevCode >= 0xdc00 &&
					prevCode <= 0xdfff &&
					i >= 2
				) {
					prevChar = text.substring(i - 2, i);
				} else {
					prevChar = text.charAt(i - 1);
				}
			}
			const atStartBoundary =
				!prevChar || !/[\p{L}\p{N}]/u.test(prevChar);

			if (atStartBoundary) {
				let matched = false;
				for (const entry of this.entries) {
					const kwNorm = ci
						? entry.keyword.toLowerCase()
						: entry.keyword;
					if (skipNorm && this.normalize(entry.target) === skipNorm) continue;
					const kwLen = kwNorm.length;
					if (i + kwLen > text.length) continue;

					if (
						normalizedText.substring(i, i + kwLen) !==
						kwNorm
					)
						continue;

					const endPos = i + kwLen;
					const nextChar =
						endPos < text.length
							? text.charAt(endPos)
							: charAfter;
					if (
						nextChar &&
						/[\p{L}\p{N}]/u.test(nextChar)
					)
						continue;

					const kw = sanitize(entry.keyword);
					const tg = sanitize(entry.target);
					if (kw.toLowerCase() === tg.toLowerCase()) {
						result.push(`[[${kw}]]`);
					} else {
						result.push(`[[${tg}|${kw}]]`);
					}
					i = endPos;
					matched = true;
					break;
				}
				if (matched) continue;
			}

			result.push(text.charAt(i));
			i++;
		}

		return result.join("");
	}

	private handleUndoOnContinue(
		view: EditorView,
		from: number,
		text: string
	): boolean {
		const pending = this.pendingUndo;
		if (!pending) return false;

		const doc = view.state.doc;
		if (
			from <= pending.from ||
			doc.sliceString(pending.from, pending.from + 2) !== "[["
		) {
			this.clearPendingUndo();
			return false;
		}

		const firstChar = text.charAt(0);
		const firstCharNorm = this.normalize(firstChar);
		const prefix =
			pending.matchedKeywordNorm + " " + firstCharNorm;
		const couldGrow = this.entries.some((e) =>
			this.normalize(e.keyword).startsWith(prefix)
		);

		if (!couldGrow) {
			this.clearPendingUndo();
			return false;
		}

		this.clearPendingUndo();
		const restoreText = pending.typedText + " " + text;
		view.dispatch({
			changes: { from: pending.from, to: from, insert: restoreText },
			selection: { anchor: pending.from + restoreText.length },
		});
		return true;
	}

	private clearPendingUndo() {
		if (this.pendingUndo) {
			window.clearTimeout(this.pendingUndo.timer);
			this.pendingUndo = null;
		}
	}

	startPeriodicRelink() {
		this.stopPeriodicRelink();
		if (!this.settings.periodicRelink) return;
		const ms = this.settings.periodicRelinkIntervalMinutes * 60 * 1000;
		this.relinkTimer = window.setInterval(() => {
			this.relinkVault(false);
		}, ms);
	}

	stopPeriodicRelink() {
		if (this.relinkTimer !== null) {
			window.clearInterval(this.relinkTimer);
			this.relinkTimer = null;
		}
	}

	private scheduleRelinkDebounced() {
		if (!this.settings.periodicRelink) return;
		if (this.relinkDebounceTimer !== null) window.clearTimeout(this.relinkDebounceTimer);
		this.relinkDebounceTimer = window.setTimeout(() => {
			this.relinkDebounceTimer = null;
			this.relinkVault(false);
		}, 5000);
	}

	private async relinkVault(showNotice: boolean) {
		if (this.relinking) return;
		if (this.entries.length === 0) return;
		this.relinking = true;

		try {
			const activeFile = this.app.workspace.getActiveFile();
			const openFiles = new Set<string>();
			this.app.workspace.iterateAllLeaves((leaf) => {
				const viewState = leaf.view?.getState();
				if (viewState?.file) openFiles.add(viewState.file as string);
			});

			const files = this.app.vault.getMarkdownFiles();
			let totalLinked = 0;

			for (const file of files) {
				if (openFiles.has(file.path)) continue;
				if (activeFile && file.path === activeFile.path) continue;

				const content = await this.app.vault.read(file);
				if (content.length > 100000) continue;

				const replaced = this.replaceKeywordsInText(content, "", "", file.basename);
				if (replaced === content) continue;

				await this.app.vault.modify(file, replaced);
				totalLinked++;
			}

			if (showNotice) {
				new Notice(
					totalLinked > 0
						? `Linkosaurus: Auto-linked keywords in ${totalLinked} note${totalLinked === 1 ? "" : "s"}.`
						: "Linkosaurus: No keywords found to link."
				);
			}
		} finally {
			this.relinking = false;
		}
	}

	private scheduleScan() {
		if (!this.settings.scanVaultLinks) return;
		if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
		this.scanTimer = window.setTimeout(() => {
			this.scanVaultLinks();
			this.scanTimer = null;
		}, 2000);
	}

	private scanVaultLinks() {
		const seen = new Set<string>();
		this.vaultEntries = [];

		const folderPaths = this.parseFolderFilter();
		const filterMode = this.settings.folderFilterMode;

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (folderPaths.length > 0) {
				const inFolder = folderPaths.some((fp) =>
					file.path.startsWith(fp)
				);
				if (filterMode === "include" && !inFolder) continue;
				if (filterMode === "exclude" && inFolder) continue;
			}

			const noteName = file.basename.trim();
			if (!noteName) continue;
			const norm = this.normalize(noteName);
			if (!seen.has(norm) && !this.manualLookup.has(norm)) {
				seen.add(norm);
				this.vaultEntries.push({
					keyword: noteName,
					target: noteName,
				});
			}

			const cache = this.app.metadataCache.getFileCache(file);

			if (this.settings.scanFrontmatterAliases && cache?.frontmatter) {
				const raw =
					cache.frontmatter.aliases ?? cache.frontmatter.alias;
				const aliasList = Array.isArray(raw)
					? raw
					: typeof raw === "string"
						? [raw]
						: [];
				for (const alias of aliasList) {
					const a = String(alias).trim();
					if (!a) continue;
					const aNorm = this.normalize(a);
					if (
						!seen.has(aNorm) &&
						!this.manualLookup.has(aNorm)
					) {
						seen.add(aNorm);
						this.vaultEntries.push({
							keyword: a,
							target: noteName,
						});
					}
				}
			}

			if (cache?.links) {
				for (const link of cache.links) {
					const raw = link.link
						.split("#")[0]!
						.split("^")[0]!
						.trim();
					if (!raw) continue;
					const linkName = (
						raw.includes("/") ? raw.split("/").pop()! : raw
					).trim();
					if (!linkName) continue;
					const linkNorm = this.normalize(linkName);
					if (
						seen.has(linkNorm) ||
						this.manualLookup.has(linkNorm)
					)
						continue;
					seen.add(linkNorm);

					this.vaultEntries.push({
						keyword: linkName,
						target: linkName,
					});
				}
			}
		}

		this.rebuildEntries();
	}

	parseManualKeywords() {
		this.manualEntries = [];
		this.manualLookup.clear();

		for (const raw of this.settings.keywordList.split("\n")) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;

			const eqIdx = line.indexOf("=");
			if (eqIdx !== -1) {
				const kw = line.substring(0, eqIdx).trim();
				const target = line.substring(eqIdx + 1).trim();
				if (kw && target) {
					this.manualEntries.push({ keyword: kw, target });
					this.manualLookup.set(this.normalize(kw), target);
				}
			} else {
				this.manualEntries.push({ keyword: line, target: line });
				this.manualLookup.set(this.normalize(line), line);
			}
		}

		this.rebuildEntries();
	}

	parseBlocklist() {
		this.blocklistSet.clear();
		for (const raw of this.settings.blocklist.split("\n")) {
			const line = raw.trim();
			if (line) {
				this.blocklistSet.add(this.normalize(line));
			}
		}
	}

	private parseFolderFilter(): string[] {
		if (!this.settings.folderFilter.trim()) return [];
		return this.settings.folderFilter
			.split("\n")
			.map((f) => f.trim())
			.filter((f) => f.length > 0)
			.map((f) => (f.endsWith("/") ? f : f + "/"));
	}

	private rebuildEntries() {
		const minLen = this.settings.minKeywordLength;

		this.entries = [];
		this.lookupMap = new Map();

		for (const entry of this.manualEntries) {
			const norm = this.normalize(entry.keyword);
			this.entries.push(entry);
			this.lookupMap.set(norm, entry.target);
		}

		if (this.settings.scanVaultLinks) {
			for (const entry of this.vaultEntries) {
				const norm = this.normalize(entry.keyword);
				if (this.lookupMap.has(norm)) continue;
				if (this.blocklistSet.has(norm)) continue;
				if (minLen > 0 && entry.keyword.length < minLen) continue;
				this.entries.push(entry);
				this.lookupMap.set(norm, entry.target);
			}
		}

		this.entries.sort((a, b) => b.keyword.length - a.keyword.length);
	}

	private isInCodeContext(
		view: EditorView,
		pos: number,
		lineText: string,
		col: number
	): boolean {
		const tree = syntaxTree(view.state);
		let node = tree.resolve(pos, -1);
		while (node) {
			if (/code/i.test(node.name)) return true;
			if (!node.parent || node.parent === node) break;
			node = node.parent;
		}

		const before = lineText.substring(0, col);
		let backticks = 0;
		for (let i = 0; i < before.length; i++) {
			if (before[i] === "`") backticks++;
		}
		if (backticks % 2 === 1) return true;

		return false;
	}

	private isInsideWikilink(textBefore: string): boolean {
		const lastOpen = textBefore.lastIndexOf("[[");
		if (lastOpen === -1) return false;
		const lastClose = textBefore.lastIndexOf("]]");
		return lastOpen > lastClose;
	}

	private matchAlias(
		textBefore: string
	): { displayText: string; target: string; start: number } | null {
		const sw = this.settings.singleWordDelimiter;
		const mw = this.settings.multiWordDelimiter;

		type Check = { kind: "single" | "multi"; delim: string };
		const checks: Check[] = [];
		if (sw.length > mw.length) {
			checks.push({ kind: "single", delim: sw });
			checks.push({ kind: "multi", delim: mw });
		} else if (sw.length < mw.length) {
			checks.push({ kind: "multi", delim: mw });
			checks.push({ kind: "single", delim: sw });
		} else {
			checks.push({ kind: "multi", delim: mw });
			checks.push({ kind: "single", delim: sw });
		}

		for (const check of checks) {
			const result =
				check.kind === "multi"
					? this.matchMultiWordAlias(textBefore, check.delim)
					: this.matchSingleWordAlias(textBefore, check.delim);
			if (result) return result;
		}
		return null;
	}

	private matchSingleWordAlias(
		textBefore: string,
		delim: string
	): { displayText: string; target: string; start: number } | null {
		const idx = textBefore.lastIndexOf(delim);
		if (idx === -1) return null;
		if (idx > 0 && textBefore.charAt(idx - 1) === ":") return null;

		const targetKw = textBefore.substring(idx + delim.length);
		if (!targetKw) return null;

		const target = this.lookupMap.get(this.normalize(targetKw));
		if (target === undefined) return null;

		const preceding = textBefore.substring(0, idx);
		let displayStart = 0;
		for (let j = preceding.length - 1; j >= 0; j--) {
			if (!/[\p{L}\p{N}]/u.test(preceding.charAt(j))) {
				displayStart = j + 1;
				break;
			}
		}
		const displayText = preceding.substring(displayStart);
		if (!displayText) return null;

		if (textBefore.substring(displayStart, displayStart + 2) === "[[")
			return null;

		return { displayText, target, start: displayStart };
	}

	private matchMultiWordAlias(
		textBefore: string,
		delim: string
	): { displayText: string; target: string; start: number } | null {
		const secondIdx = textBefore.lastIndexOf(delim);
		if (secondIdx === -1) return null;

		const targetKw = textBefore.substring(secondIdx + delim.length);
		if (!targetKw) return null;

		const target = this.lookupMap.get(this.normalize(targetKw));
		if (target === undefined) return null;

		const beforeSecond = textBefore.substring(0, secondIdx);
		const firstIdx = beforeSecond.lastIndexOf(delim);
		if (firstIdx === -1) return null;
		if (firstIdx > 0 && textBefore.charAt(firstIdx - 1) === ":") return null;

		const displayText = beforeSecond.substring(firstIdx + delim.length);
		if (!displayText) return null;

		if (textBefore.substring(firstIdx, firstIdx + 2) === "[[")
			return null;

		return { displayText, target, start: firstIdx };
	}

	private matchAliasInText(
		text: string,
		pos: number,
		skipNorm?: string
	): { replacement: string; end: number } | null {
		const sw = this.settings.singleWordDelimiter;
		const mw = this.settings.multiWordDelimiter;

		type Check = { kind: "single" | "multi"; delim: string };
		const checks: Check[] = [];
		if (sw.length > mw.length) {
			checks.push({ kind: "single", delim: sw });
			checks.push({ kind: "multi", delim: mw });
		} else if (sw.length < mw.length) {
			checks.push({ kind: "multi", delim: mw });
			checks.push({ kind: "single", delim: sw });
		} else {
			checks.push({ kind: "multi", delim: mw });
			checks.push({ kind: "single", delim: sw });
		}

		for (const check of checks) {
			const result =
				check.kind === "multi"
					? this.matchMultiWordAliasInText(text, pos, check.delim, skipNorm)
					: this.matchSingleWordAliasInText(text, pos, check.delim, skipNorm);
			if (result) return result;
		}
		return null;
	}

	private matchSingleWordAliasInText(
		text: string,
		pos: number,
		delim: string,
		skipNorm?: string
	): { replacement: string; end: number } | null {
		if (pos > 0 && /[\p{L}\p{N}]/u.test(text.charAt(pos - 1))) return null;

		const spaceAfterWord = text.indexOf(delim, pos);
		if (spaceAfterWord === -1 || spaceAfterWord === pos) return null;

		const displayText = text.substring(pos, spaceAfterWord);
		if (/\s/.test(displayText)) return null;
		if (displayText.startsWith("[[")) return null;
		if (spaceAfterWord > 0 && text.charAt(spaceAfterWord - 1) === ":") return null;

		const targetStart = spaceAfterWord + delim.length;
		let targetEnd = targetStart;
		while (targetEnd < text.length && !/\s/.test(text.charAt(targetEnd)))
			targetEnd++;

		const targetKw = text.substring(targetStart, targetEnd);
		if (!targetKw) return null;

		const target = this.lookupMap.get(this.normalize(targetKw));
		if (target === undefined) return null;
		if (skipNorm && this.normalize(target) === skipNorm) return null;

		const t = sanitize(target);
		const d = sanitize(displayText);
		return { replacement: `[[${t}|${d}]]`, end: targetEnd };
	}

	private matchMultiWordAliasInText(
		text: string,
		pos: number,
		delim: string,
		skipNorm?: string
	): { replacement: string; end: number } | null {
		if (text.substring(pos, pos + delim.length) !== delim) return null;
		if (pos > 0 && text.charAt(pos - 1) === ":") return null;

		const afterFirst = pos + delim.length;
		const secondIdx = text.indexOf(delim, afterFirst);
		if (secondIdx === -1) return null;

		const displayText = text.substring(afterFirst, secondIdx);
		if (!displayText) return null;

		const targetStart = secondIdx + delim.length;
		let targetEnd = targetStart;
		while (targetEnd < text.length && !/\s/.test(text.charAt(targetEnd)))
			targetEnd++;

		const targetKw = text.substring(targetStart, targetEnd);
		if (!targetKw) return null;

		const target = this.lookupMap.get(this.normalize(targetKw));
		if (target === undefined) return null;
		if (skipNorm && this.normalize(target) === skipNorm) return null;

		const t = sanitize(target);
		const d = sanitize(displayText);
		return { replacement: `[[${t}|${d}]]`, end: targetEnd };
	}

	private matchKeyword(
		textBefore: string
	): {
		keyword: string;
		target: string;
		start: number;
		typedText: string;
	} | null {
		const normalizedText = this.normalize(textBefore);

		for (const entry of this.entries) {
			const kwNorm = this.normalize(entry.keyword);
			const kwLen = kwNorm.length;
			if (normalizedText.length < kwLen) continue;

			const start = normalizedText.length - kwLen;
			if (normalizedText.substring(start) !== kwNorm) continue;

			if (start > 0) {
				const ch = textBefore.charAt(start - 1);
				if (/[\p{L}\p{N}]/u.test(ch)) continue;
			}

			if (textBefore.substring(start, start + 2) === "[[") continue;
			if (
				start >= 2 &&
				textBefore.substring(start - 2, start) === "[["
			)
				continue;

			return {
				keyword: entry.keyword,
				target: entry.target,
				start,
				typedText: textBefore.substring(start),
			};
		}

		return null;
	}

	getVaultKeywords(): string[] {
		return this.vaultEntries
			.map((e) => e.keyword)
			.sort((a, b) => a.localeCompare(b));
	}

	debouncedSave() {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveSettings();
			this.saveTimer = null;
		}, 500);
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		if (typeof this.settings.keywordList !== "string")
			this.settings.keywordList = "";
		if (typeof this.settings.blocklist !== "string")
			this.settings.blocklist = "";
		if (typeof this.settings.folderFilter !== "string")
			this.settings.folderFilter = "";
		if (
			this.settings.folderFilterMode !== "include" &&
			this.settings.folderFilterMode !== "exclude"
		)
			this.settings.folderFilterMode = "exclude";
		if (typeof this.settings.singleWordDelimiter !== "string" || !this.settings.singleWordDelimiter)
			this.settings.singleWordDelimiter = DEFAULT_SETTINGS.singleWordDelimiter;
		if (typeof this.settings.multiWordDelimiter !== "string" || !this.settings.multiWordDelimiter)
			this.settings.multiWordDelimiter = DEFAULT_SETTINGS.multiWordDelimiter;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.parseBlocklist();
		this.parseManualKeywords();
		if (this.settings.scanVaultLinks) {
			this.scheduleScan();
		}
	}
}

class AutoLinkSettingTab extends PluginSettingTab {
	plugin: AutoLinkKeywordsPlugin;

	constructor(app: App, plugin: AutoLinkKeywordsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Linkosaurus" });

		const desc = containerEl.createEl("div");
		desc.style.marginBottom = "1em";
		desc.innerHTML =
			"One keyword per line. Lines starting with <code>#</code> are comments.<br>" +
			"<code>Dortmund</code> → <code>[[Dortmund]]</code><br>" +
			"<code>NAS = UGREEN NAS</code> → <code>[[UGREEN NAS|NAS]]</code><br><br>" +
			"<b>Single-word alias:</b> <code>York//keyword</code> + Space → <code>[[target|York]]</code><br>" +
			"<b>Multi-word alias:</b> <code>///New York///keyword</code> + Space → <code>[[target|New York]]</code><br>" +
			"Delimiters are configurable below.<br><br>" +
			"<b>Shortcut:</b> select a word and use the <em>Link selection and add to keyword list</em> command " +
			"(assign a hotkey in Settings → Hotkeys).";

		new Setting(containerEl).setName("Keyword list").addTextArea((text) => {
			text.inputEl.style.fontFamily = "monospace";
			text.inputEl.style.width = "100%";
			text.inputEl.rows = 28;
			text.setValue(this.plugin.settings.keywordList).onChange(
				(value) => {
					this.plugin.settings.keywordList = value;
					this.plugin.parseManualKeywords();
					this.plugin.debouncedSave();
				}
			);
		});

		new Setting(containerEl)
			.setName("Case-insensitive matching")
			.setDesc(
				"Match keywords regardless of upper/lower case (e.g. typing “dortmund” matches keyword “Dortmund”)."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.caseInsensitive)
					.onChange(async (value) => {
						this.plugin.settings.caseInsensitive = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Single-word alias delimiter")
			.setDesc(
				"Delimiter between display text and keyword for single-word aliases. " +
				"Example: York//Urlaub → [[Urlaub|York]]"
			)
			.addText((text) => {
				text.inputEl.style.width = "80px";
				text.inputEl.style.fontFamily = "monospace";
				text.setPlaceholder("//")
					.setValue(this.plugin.settings.singleWordDelimiter)
					.onChange(async (value) => {
						if (!value) {
							text.inputEl.style.borderColor = "var(--text-error)";
							return;
						}
						if (value === this.plugin.settings.multiWordDelimiter) {
							text.inputEl.style.borderColor = "var(--text-error)";
							new Notice("Single-word and multi-word delimiters must be different.");
							return;
						}
						text.inputEl.style.borderColor = "";
						this.plugin.settings.singleWordDelimiter = value;
						await this.plugin.saveSettings();
						if (
							value.includes(this.plugin.settings.multiWordDelimiter) ||
							this.plugin.settings.multiWordDelimiter.includes(value)
						) {
							new Notice("Warning: one delimiter is a substring of the other. This may cause parsing conflicts.");
						}
					});
			});

		new Setting(containerEl)
			.setName("Multi-word alias delimiter")
			.setDesc(
				"Delimiter that wraps display text for multi-word aliases. " +
				"Example: ///New York///Urlaub → [[Urlaub|New York]]"
			)
			.addText((text) => {
				text.inputEl.style.width = "80px";
				text.inputEl.style.fontFamily = "monospace";
				text.setPlaceholder("///")
					.setValue(this.plugin.settings.multiWordDelimiter)
					.onChange(async (value) => {
						if (!value) {
							text.inputEl.style.borderColor = "var(--text-error)";
							return;
						}
						if (value === this.plugin.settings.singleWordDelimiter) {
							text.inputEl.style.borderColor = "var(--text-error)";
							new Notice("Single-word and multi-word delimiters must be different.");
							return;
						}
						text.inputEl.style.borderColor = "";
						this.plugin.settings.multiWordDelimiter = value;
						await this.plugin.saveSettings();
						if (
							value.includes(this.plugin.settings.singleWordDelimiter) ||
							this.plugin.settings.singleWordDelimiter.includes(value)
						) {
							new Notice("Warning: one delimiter is a substring of the other. This may cause parsing conflicts.");
						}
					});
			});

		new Setting(containerEl)
			.setName("Auto-detect vault links")
			.setDesc(
				"Automatically use all note names and existing wikilinks from the vault as keywords."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.scanVaultLinks)
					.onChange(async (value) => {
						this.plugin.settings.scanVaultLinks = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (this.plugin.settings.scanVaultLinks) {
			new Setting(containerEl)
				.setName("Include frontmatter aliases")
				.setDesc(
					"Use aliases defined in note frontmatter (aliases/alias field) as additional keywords."
				)
				.addToggle((toggle) => {
					toggle
						.setValue(
							this.plugin.settings.scanFrontmatterAliases
						)
						.onChange(async (value) => {
							this.plugin.settings.scanFrontmatterAliases =
								value;
							await this.plugin.saveSettings();
						});
				});

			new Setting(containerEl)
				.setName("Minimum keyword length")
				.setDesc(
					"Ignore auto-detected keywords shorter than this (0 = no limit). Does not affect manual keywords."
				)
				.addText((text) => {
					text.inputEl.type = "number";
					text.inputEl.style.width = "60px";
					text.inputEl.min = "0";
					text.inputEl.max = "50";
					text.setValue(
						String(this.plugin.settings.minKeywordLength)
					).onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 0) {
							this.plugin.settings.minKeywordLength = num;
							await this.plugin.saveSettings();
						}
					});
				});

			new Setting(containerEl)
				.setName("Blocklist")
				.setDesc(
					"Keywords to exclude from auto-linking (one per line). Does not affect manual keywords."
				)
				.addTextArea((text) => {
					text.inputEl.style.fontFamily = "monospace";
					text.inputEl.style.width = "100%";
					text.inputEl.rows = 6;
					text.setPlaceholder("Home\nTODO\nDaily")
						.setValue(this.plugin.settings.blocklist)
						.onChange((value) => {
							this.plugin.settings.blocklist = value;
							this.plugin.parseBlocklist();
							this.plugin.parseManualKeywords();
							this.plugin.debouncedSave();
						});
				});

			new Setting(containerEl)
				.setName("Folder filter mode")
				.setDesc(
					"Choose whether the listed folders are excluded or are the only ones included."
				)
				.addDropdown((dropdown) => {
					dropdown
						.addOption("exclude", "Exclude listed folders")
						.addOption("include", "Include only listed folders")
						.setValue(this.plugin.settings.folderFilterMode)
						.onChange(async (value: string) => {
							this.plugin.settings.folderFilterMode =
								value as "include" | "exclude";
							await this.plugin.saveSettings();
						});
				});

			new Setting(containerEl)
				.setName("Folder filter")
				.setDesc(
					"Folders to include or exclude from vault scanning (one per line)."
				)
				.addTextArea((text) => {
					text.inputEl.style.fontFamily = "monospace";
					text.inputEl.style.width = "100%";
					text.inputEl.rows = 4;
					text.setPlaceholder("Templates\nDaily Notes")
						.setValue(this.plugin.settings.folderFilter)
						.onChange((value) => {
							this.plugin.settings.folderFilter = value;
							this.plugin.debouncedSave();
						});
				});

			containerEl.createEl("h3", { text: "Periodic auto-relink" });

			new Setting(containerEl)
				.setName("Enable periodic auto-relink")
				.setDesc(
					"Periodically scan all notes and retroactively convert plain-text keywords to wikilinks. " +
					"Notes currently open in the editor are skipped to avoid cursor jumps."
				)
				.addToggle((toggle) => {
					toggle
						.setValue(this.plugin.settings.periodicRelink)
						.onChange(async (value) => {
							this.plugin.settings.periodicRelink = value;
							await this.plugin.saveSettings();
							if (value) {
								this.plugin.startPeriodicRelink();
							} else {
								this.plugin.stopPeriodicRelink();
							}
							this.display();
						});
				});

			if (this.plugin.settings.periodicRelink) {
				new Setting(containerEl)
					.setName("Relink interval (minutes)")
					.setDesc(
						"How often to scan the vault for unlinkable keywords (1–60 minutes)."
					)
					.addText((text) => {
						text.inputEl.type = "number";
						text.inputEl.style.width = "60px";
						text.inputEl.min = "1";
						text.inputEl.max = "60";
						text.setValue(
							String(this.plugin.settings.periodicRelinkIntervalMinutes)
						).onChange(async (value) => {
							const num = parseInt(value, 10);
							if (!isNaN(num) && num >= 1 && num <= 60) {
								this.plugin.settings.periodicRelinkIntervalMinutes = num;
								await this.plugin.saveSettings();
								this.plugin.startPeriodicRelink();
							}
						});
					});
			}

			const vault = this.plugin.getVaultKeywords();
			const details = containerEl.createEl("details");
			details.style.marginTop = "0.5em";
			const summary = details.createEl("summary");
			summary.style.cursor = "pointer";
			summary.style.color = "var(--text-muted)";
			summary.setText(
				`Auto-detected keywords (${vault.length})`
			);
			if (vault.length > 0) {
				const list = details.createEl("div");
				list.style.fontFamily = "monospace";
				list.style.fontSize = "0.85em";
				list.style.marginTop = "0.5em";
				list.style.maxHeight = "300px";
				list.style.overflowY = "auto";
				list.style.padding = "0.5em";
				list.style.background = "var(--background-secondary)";
				list.style.borderRadius = "4px";
				list.setText(vault.join("\n"));
				list.style.whiteSpace = "pre-wrap";
			}
		}
	}
}
