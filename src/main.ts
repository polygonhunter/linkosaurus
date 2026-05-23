import { Plugin, PluginSettingTab, App, Setting } from "obsidian";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

interface AutoLinkSettings {
	keywordList: string;
	scanVaultLinks: boolean;
}

const DEFAULT_SETTINGS: AutoLinkSettings = {
	keywordList: "",
	scanVaultLinks: true,
};

interface KeywordEntry {
	keyword: string;
	target: string;
}

interface PendingUndo {
	from: number;
	typedText: string;
	matchedKeywordLower: string;
	timer: number;
}

function sanitize(text: string): string {
	return text.replace(/\]\]|\[\[|[|#^\n\r\0]/g, "");
}

export default class AutoLinkKeywordsPlugin extends Plugin {
	settings: AutoLinkSettings = { ...DEFAULT_SETTINGS };
	private entries: KeywordEntry[] = [];
	private lookupMap = new Map<string, string>();
	private manualEntries: KeywordEntry[] = [];
	private manualLookup = new Map<string, string>();
	private vaultEntries: KeywordEntry[] = [];
	private scanTimer: number | null = null;
	private saveTimer: number | null = null;
	private pendingUndo: PendingUndo | null = null;

	async onload() {
		await this.loadSettings();
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

				if (!this.manualLookup.has(text.toLowerCase())) {
					const list = this.settings.keywordList.trimEnd();
					const sep = list ? "\n" : "";
					this.settings.keywordList = list + sep + text;
					this.saveSettings();
				}
			},
		});

		this.addSettingTab(new AutoLinkSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.scheduleScan();
		});

		this.registerEvent(
			this.app.metadataCache.on("resolved", () => this.scheduleScan())
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", () => this.scheduleScan())
		);
		this.registerEvent(
			this.app.vault.on("create", () => this.scheduleScan())
		);
		this.registerEvent(
			this.app.vault.on("delete", () => this.scheduleScan())
		);
		this.registerEvent(
			this.app.vault.on("rename", () => this.scheduleScan())
		);
	}

	onunload() {
		if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.clearPendingUndo();
	}

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
			return this.handleUndoOnContinue(view, from, text);
		}

		if (text === " ") {
			return this.handleSpaceInput(view, from);
		}

		return false;
	}

	private handleSpaceInput(view: EditorView, pos: number): boolean {
		const state = view.state;
		const line = state.doc.lineAt(pos);
		const colOffset = pos - line.from;
		const textBefore = line.text.substring(0, colOffset);

		if (!textBefore.length) return false;
		if (this.isInCodeContext(view, pos, line.text, colOffset)) return false;
		if (this.isInsideWikilink(textBefore)) return false;

		const tripleSlash = this.matchTripleSlash(textBefore);
		if (tripleSlash) {
			const absStart = line.from + tripleSlash.start;
			const t = sanitize(tripleSlash.target);
			const d = sanitize(tripleSlash.displayText);
			const insert = `[[${t}|${d}]] `;
			view.dispatch({
				changes: { from: absStart, to: pos, insert },
				selection: { anchor: absStart + insert.length },
			});
			return true;
		}

		const direct = this.matchKeyword(textBefore);
		if (direct) {
			const absStart = line.from + direct.start;
			const kw = sanitize(direct.keyword);
			const tg = sanitize(direct.target);
			const insert =
				kw.toLowerCase() === tg.toLowerCase()
					? `[[${kw}]] `
					: `[[${tg}|${kw}]] `;
			view.dispatch({
				changes: { from: absStart, to: pos, insert },
				selection: { anchor: absStart + insert.length },
			});

			const kwLower = direct.keyword.toLowerCase();
			const prefix = kwLower + " ";
			const hasLonger = this.entries.some(
				(e) =>
					e.keyword.length > direct.keyword.length &&
					e.keyword.toLowerCase().startsWith(prefix)
			);
			if (hasLonger) {
				this.clearPendingUndo();
				this.pendingUndo = {
					from: absStart,
					typedText: direct.typedText,
					matchedKeywordLower: kwLower,
					timer: window.setTimeout(
						() => (this.pendingUndo = null),
						5000
					),
				};
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

		const replaced = this.replaceKeywordsInText(
			text,
			charBefore,
			charAfter
		);
		if (replaced === text) return false;

		if (this.pendingUndo) this.clearPendingUndo();

		view.dispatch({
			changes: { from, to, insert: replaced },
			selection: { anchor: from + replaced.length },
		});
		return true;
	}

	private replaceKeywordsInText(
		text: string,
		charBefore: string,
		charAfter: string
	): string {
		const result: string[] = [];
		const lowerText = text.toLowerCase();
		let i = 0;

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
					result.push(
						text.substring(i, closeIdx + 2)
					);
					i = closeIdx + 2;
				} else {
					result.push(text.substring(i));
					i = text.length;
				}
				continue;
			}

			if (text.charAt(i) === "[") {
				const bracketClose = text.indexOf("](", i + 1);
				if (bracketClose !== -1) {
					const parenClose = text.indexOf(
						")",
						bracketClose + 2
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
					result.push(
						text.substring(i, closeIdx + 1)
					);
					i = closeIdx + 1;
				} else {
					result.push(text.substring(i));
					i = text.length;
				}
				continue;
			}

			const lower7 = lowerText.substring(i, i + 8);
			if (
				lower7.startsWith("http://") ||
				lower7.startsWith("https://")
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
					const kwLower = entry.keyword.toLowerCase();
					const kwLen = kwLower.length;
					if (i + kwLen > text.length) continue;

					if (
						lowerText.substring(i, i + kwLen) !==
						kwLower
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
		const prefix =
			pending.matchedKeywordLower +
			" " +
			firstChar.toLowerCase();
		const couldGrow = this.entries.some((e) =>
			e.keyword.toLowerCase().startsWith(prefix)
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

		for (const file of this.app.vault.getMarkdownFiles()) {
			const noteName = file.basename.trim();
			if (!noteName) continue;
			const lower = noteName.toLowerCase();
			if (!seen.has(lower) && !this.manualLookup.has(lower)) {
				seen.add(lower);
				this.vaultEntries.push({
					keyword: noteName,
					target: noteName,
				});
			}

			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache?.links) continue;

			for (const link of cache.links) {
				const raw = link.link.split("#")[0]!.split("^")[0]!.trim();
				if (!raw) continue;
				const linkName = (
					raw.includes("/") ? raw.split("/").pop()! : raw
				).trim();
				if (!linkName) continue;
				const linkLower = linkName.toLowerCase();
				if (seen.has(linkLower) || this.manualLookup.has(linkLower))
					continue;
				seen.add(linkLower);

				this.vaultEntries.push({
					keyword: linkName,
					target: linkName,
				});
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
					this.manualLookup.set(kw.toLowerCase(), target);
				}
			} else {
				this.manualEntries.push({ keyword: line, target: line });
				this.manualLookup.set(line.toLowerCase(), line);
			}
		}

		this.rebuildEntries();
	}

	private rebuildEntries() {
		this.entries = [...this.manualEntries];
		this.lookupMap = new Map(this.manualLookup);

		if (this.settings.scanVaultLinks) {
			for (const entry of this.vaultEntries) {
				const lower = entry.keyword.toLowerCase();
				if (!this.lookupMap.has(lower)) {
					this.entries.push(entry);
					this.lookupMap.set(lower, entry.target);
				}
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

	private matchTripleSlash(
		textBefore: string
	): { displayText: string; target: string; start: number } | null {
		const idx = textBefore.lastIndexOf("///");
		if (idx === -1) return null;

		const targetKw = textBefore.substring(idx + 3);
		if (!targetKw) return null;

		const target = this.lookupMap.get(targetKw.toLowerCase());
		if (target === undefined) return null;

		const preceding = textBefore.substring(0, idx);
		const lastSpace = preceding.lastIndexOf(" ");
		const displayStart = lastSpace + 1;
		const displayText = preceding.substring(displayStart);
		if (!displayText) return null;

		if (textBefore.substring(displayStart, displayStart + 2) === "[[")
			return null;

		return { displayText, target, start: displayStart };
	}

	private matchKeyword(
		textBefore: string
	): {
		keyword: string;
		target: string;
		start: number;
		typedText: string;
	} | null {
		const lowerText = textBefore.toLowerCase();

		for (const entry of this.entries) {
			const kwLower = entry.keyword.toLowerCase();
			const kwLen = kwLower.length;
			if (lowerText.length < kwLen) continue;

			const start = lowerText.length - kwLen;
			if (lowerText.substring(start) !== kwLower) continue;

			if (start > 0) {
				const ch = textBefore[start - 1];
				if (ch !== " " && ch !== "\t") continue;
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
	}

	async saveSettings() {
		await this.saveData(this.settings);
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

		containerEl.createEl("h2", { text: "AutoLink Keywords" });

		const desc = containerEl.createEl("div");
		desc.style.marginBottom = "1em";
		desc.innerHTML =
			"One keyword per line. Lines starting with <code>#</code> are comments.<br>" +
			"<code>Dortmund</code> → <code>[[Dortmund]]</code><br>" +
			"<code>NAS = UGREEN NAS</code> → <code>[[UGREEN NAS|NAS]]</code><br><br>" +
			"<b>Alias syntax:</b> type <code>displayText///keyword</code> then Space → <code>[[target|displayText]]</code><br><br>" +
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
