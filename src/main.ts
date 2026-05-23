import { Plugin, PluginSettingTab, App, Setting, TFile } from "obsidian";
import { keymap, EditorView } from "@codemirror/view";
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

export default class AutoLinkKeywordsPlugin extends Plugin {
	settings: AutoLinkSettings = DEFAULT_SETTINGS;
	private entries: KeywordEntry[] = [];
	private lookupMap = new Map<string, string>();
	private manualEntries: KeywordEntry[] = [];
	private manualLookup = new Map<string, string>();
	private vaultEntries: KeywordEntry[] = [];
	private scanTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		this.parseManualKeywords();

		this.registerEditorExtension(
			keymap.of([
				{
					key: "Space",
					run: (view: EditorView) => this.handleSpace(view),
				},
			])
		);

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
					while (start > 0 && !/\s/.test(line[start - 1]!))
						start--;
					while (end < line.length && !/\s/.test(line[end]!))
						end++;
					text = line.substring(start, end);
					if (!text) return;
					editor.setSelection(
						{ line: cursor.line, ch: start },
						{ line: cursor.line, ch: end }
					);
				}

				editor.replaceSelection(`[[${text}]]`);

				if (!this.manualLookup.has(text.toLowerCase())) {
					const sep = this.settings.keywordList.trim() ? "\n" : "";
					this.settings.keywordList += sep + text;
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
			this.app.vault.on("delete", () => this.scheduleScan())
		);
		this.registerEvent(
			this.app.vault.on("rename", () => this.scheduleScan())
		);
	}

	private scheduleScan() {
		if (!this.settings.scanVaultLinks) return;
		if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
		this.scanTimer = window.setTimeout(() => {
			this.scanVaultLinks();
			this.scanTimer = null;
		}, 500);
	}

	private scanVaultLinks() {
		const seen = new Set<string>();
		this.vaultEntries = [];

		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache?.links) continue;

			for (const link of cache.links) {
				const raw = link.link.split("#")[0]!.split("^")[0]!.trim();
				if (!raw) continue;
				const noteName = raw.includes("/")
					? raw.split("/").pop()!
					: raw;
				const lower = noteName.toLowerCase();
				if (seen.has(lower)) continue;
				seen.add(lower);

				if (!this.manualLookup.has(lower)) {
					this.vaultEntries.push({
						keyword: noteName,
						target: noteName,
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

	private handleSpace(view: EditorView): boolean {
		const state = view.state;
		const sel = state.selection.main;
		if (!sel.empty) return false;

		const pos = sel.head;
		const line = state.doc.lineAt(pos);
		const colOffset = pos - line.from;
		const textBefore = line.text.substring(0, colOffset);

		if (!textBefore.length) return false;

		if (this.isInCodeContext(view, pos, line.text, colOffset)) return false;
		if (this.isInsideWikilink(textBefore)) return false;

		const tripleSlash = this.matchTripleSlash(textBefore);
		if (tripleSlash) {
			const absStart = line.from + tripleSlash.start;
			const insert = `[[${tripleSlash.target}|${tripleSlash.displayText}]] `;
			view.dispatch({
				changes: { from: absStart, to: pos, insert },
				selection: { anchor: absStart + insert.length },
			});
			return true;
		}

		const direct = this.matchKeyword(textBefore);
		if (direct) {
			const absStart = line.from + direct.start;
			const insert =
				direct.keyword.toLowerCase() === direct.target.toLowerCase()
					? `[[${direct.keyword}]] `
					: `[[${direct.target}|${direct.keyword}]] `;
			view.dispatch({
				changes: { from: absStart, to: pos, insert },
				selection: { anchor: absStart + insert.length },
			});
			return true;
		}

		return false;
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
	): { keyword: string; target: string; start: number } | null {
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
			};
		}

		return null;
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
			this.scanVaultLinks();
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
				async (value) => {
					this.plugin.settings.keywordList = value;
					await this.plugin.saveSettings();
				}
			);
		});

		new Setting(containerEl)
			.setName("Auto-detect vault links")
			.setDesc(
				"Automatically add all wikilinked note names from the vault as keywords."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.scanVaultLinks)
					.onChange(async (value) => {
						this.plugin.settings.scanVaultLinks = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
