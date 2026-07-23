import {
	Plugin,
	PluginSettingTab,
	App,
	Setting,
	Notice,
	EditorSuggest,
	prepareFuzzySearch,
	renderMatches,
	setIcon,
	type Editor,
	type EditorPosition,
	type EditorSuggestContext,
	type EditorSuggestTriggerInfo,
	type KeymapEventHandler,
	type SearchResult,
	type SettingDefinitionItem,
	type TFile,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { Prec, type ChangeDesc } from "@codemirror/state";

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
	aliasSuggestEnabled: boolean;
	aliasSuggestEnterAccepts: boolean;
	aliasSuggestTabAccepts: boolean;
	noteSearchEnabled: boolean;
	noteSearchTrigger: string;
	urlAutolinkEnabled: boolean;
	urlAutolinkTlds: string;
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
	aliasSuggestEnabled: true,
	aliasSuggestEnterAccepts: true,
	aliasSuggestTabAccepts: true,
	noteSearchEnabled: true,
	noteSearchTrigger: ";;",
	urlAutolinkEnabled: true,
	urlAutolinkTlds: "de\ncom\norg\nnet\nio\nshop\napp\ndev",
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

// Snapshot of the text a link replaced, kept briefly so stale IME/autocorrect
// re-commits (sent against pre-link coordinates) can be recognized and dropped.
interface LastAutolink {
	view: EditorView;
	time: number;
	from: number;
	to: number;
	text: string;
}

interface DeferredBase {
	view: EditorView;
	from: number;
	tries: number;
	timer: number;
}

// A single trigger character typed during composition: link the keyword
// ending right before it once the composition has settled.
interface DeferredTrigger extends DeferredBase {
	kind: "trigger";
	trigger: string;
	setupPendingUndo: boolean;
	// Expected document content ending at the trigger, captured when the
	// deferral was scheduled; must still match when the deferral fires.
	context: string;
}

// A multi-character commit (swipe/dictation/autocorrect) that arrived during
// composition: transform the whole committed range once it has settled.
interface DeferredBulk extends DeferredBase {
	kind: "bulk";
	text: string;
}

type DeferredAutolink = DeferredTrigger | DeferredBulk;

function sanitize(text: string): string {
	return text.replace(/\]\]|\[\[|[|#^\\/\n\r\0]/g, "");
}

export default class AutoLinkKeywordsPlugin extends Plugin {
	settings: AutoLinkSettings = { ...DEFAULT_SETTINGS };
	private entries: KeywordEntry[] = [];
	private lookupMap = new Map<string, string>();
	private manualEntries: KeywordEntry[] = [];
	private manualLookup = new Map<string, string>();
	private vaultEntries: KeywordEntry[] = [];
	private blocklistSet = new Set<string>();
	private tldSet = new Set<string>();
	private scanTimer: number | null = null;
	private saveTimer: number | null = null;
	private pendingUndo: PendingUndo | null = null;
	private lastAutolink: LastAutolink | null = null;
	private deferredAutolinks: DeferredAutolink[] = [];
	private relinkTimer: number | null = null;
	private relinkDebounceTimer: number | null = null;
	private relinking = false;
	private aliasSuggest: AliasTargetSuggest | null = null;

	async onload() {
		await this.loadSettings();
		this.parseBlocklist();
		this.parseManualKeywords();
		this.parseTlds();

		this.registerEditorExtension([
			Prec.highest(
				EditorView.inputHandler.of(
					(
						view: EditorView,
						from: number,
						to: number,
						text: string
					) => this.handleInput(view, from, to, text)
				)
			),
			EditorView.updateListener.of((update) =>
				this.handleEditorUpdate(
					update.docChanged,
					update.selectionSet,
					update.changes
				)
			),
			Prec.highest(
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
				})
			),
		]);

		this.aliasSuggest = new AliasTargetSuggest(this.app, this);
		this.registerEditorSuggest(this.aliasSuggest);

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
					const list = this.settings.keywordList.replace(/\s+$/, "");
					const sep = list ? "\n" : "";
					this.settings.keywordList = list + sep + text;
					void this.saveSettings();
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
				void this.relinkVault(true);
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
		this.cancelDeferredAutolinks();
	}

	private normalize(text: string): string {
		return this.settings.caseInsensitive ? text.toLowerCase() : text;
	}

	private handleEditorUpdate(
		docChanged: boolean,
		selectionSet: boolean,
		changes?: ChangeDesc
	) {
		if (this.pendingUndo && selectionSet && !docChanged) {
			this.clearPendingUndo();
		}
		// Any document change that is not our own autolink dispatch (which
		// re-records afterwards) makes the recorded coordinates meaningless —
		// e.g. undo restoring the pre-link text would otherwise make the
		// record match legitimate edits.
		if (this.lastAutolink && docChanged) {
			this.lastAutolink = null;
		}
		// Keep pending deferrals aligned with the document: when one deferral
		// dispatches (or any other change lands), the positions of the queued
		// ones shift with it. Content is re-verified when each one fires.
		// assoc -1 anchors positions left, so a deferral scheduled just
		// before its own trigger's default insertion is not pushed past it.
		if (docChanged && changes) {
			for (const d of this.deferredAutolinks) {
				d.from = changes.mapPos(d.from, -1);
			}
		}
	}

	private static PUNCTUATION_TRIGGERS = ").,!?:;";

	private handleInput(
		view: EditorView,
		from: number,
		to: number,
		text: string
	): boolean {
		if (!text) return false;

		// Mobile keyboards (IME/autocorrect) sometimes re-commit the word they
		// just finished, using coordinates from before our link dispatch
		// shifted the text. Applying that stale edit corrupts the fresh link
		// ("UL Dash GmbH" → "[[UL DasGmbHbH]]"), so swallow it instead.
		if (from !== to && this.isStaleRecommit(view, from, to, text)) {
			return true;
		}

		// Some keyboards split the commit into two events: the word
		// replacement (handled above) and a follow-up space at the pre-link
		// end-of-word offset. Applied as-is it would land inside the link.
		if (
			from === to &&
			text === " " &&
			this.isStaleSpaceInsert(view, from)
		) {
			return true;
		}

		if (text === ". ") {
			if (this.pendingUndo) this.clearPendingUndo();

			const replacedText = view.state.doc.sliceString(from, to);
			if (replacedText && !/^\s*$/.test(replacedText)) {
				const sel = view.state.selection.main;
				if (!sel.empty) return true;
				const cursor = sel.head;
				const before =
					cursor > 0
						? view.state.doc.sliceString(cursor - 1, cursor)
						: "";
				const dispatchFrom = before === " " ? cursor - 1 : cursor;
				view.dispatch({
					changes: {
						from: dispatchFrom,
						to: cursor,
						insert: ". ",
					},
					selection: { anchor: dispatchFrom + 2 },
				});
				return true;
			}

			if (this.isImeActive(view)) {
				this.scheduleDeferredAutolink(
					view,
					from,
					". ",
					false,
					AutoLinkKeywordsPlugin.deferredContext(
						view.state.doc.sliceString(
							Math.max(0, from - 24),
							from
						),
						". "
					)
				);
				return false;
			}
			return this.tryAutolinkBeforeCursor(view, from, ". ", false, to);
		}

		if (text.length > 1) {
			return this.handleBulkInput(view, from, to, text);
		}

		if (from !== to) return false;

		if (this.pendingUndo) {
			if (/^\s+$/.test(text)) return false;
			// A keyword only grows into a longer one across word characters
			// (e.g. "Open" → "Open Source"). Any non-word character — sentence
			// punctuation or a separator like "-" in "T-Rex - Facebook" — ends
			// the current keyword, so keep the link that was already created
			// instead of undoing it.
			if (!/[\p{L}\p{N}]/u.test(text)) {
				this.clearPendingUndo();
				return false;
			}
			return this.handleUndoOnContinue(view, from, text);
		}

		if (!AutoLinkKeywordsPlugin.isTriggerChar(text)) return false;

		// Dispatching a document change while an IME composition is active
		// desynchronizes the keyboard from the editor (CodeMirror applies its
		// late commits at stale offsets). Let the trigger character through
		// unchanged and link shortly after the composition has settled.
		if (this.isImeActive(view)) {
			this.scheduleDeferredAutolink(
				view,
				from,
				text,
				text === " ",
				AutoLinkKeywordsPlugin.deferredContext(
					view.state.doc.sliceString(Math.max(0, from - 24), from),
					text
				)
			);
			return false;
		}

		if (text === " ") {
			return this.tryAutolinkBeforeCursor(view, from, " ", true);
		}

		if (text === "\n") {
			return this.tryAutolinkBeforeCursor(view, from, "\n", false);
		}

		return this.tryAutolinkBeforeCursor(view, from, text, false);
	}

	private handleEnterKey(view: EditorView): boolean {
		// While the alias suggestion popup is open and set to accept on Enter,
		// the keypress belongs to it — autolinking here as well would apply
		// the same replacement twice.
		if (this.aliasSuggest?.consumesEnter()) return false;

		if (this.pendingUndo) {
			this.clearPendingUndo();
			return false;
		}

		const sel = view.state.selection.main;
		if (!sel.empty) return false;

		if (this.isImeActive(view)) {
			this.scheduleDeferredAutolink(
				view,
				sel.head,
				"\n",
				false,
				AutoLinkKeywordsPlugin.deferredContext(
					view.state.doc.sliceString(
						Math.max(0, sel.head - 24),
						sel.head
					),
					"\n"
				)
			);
			return false;
		}

		return this.tryAutolinkBeforeCursor(view, sel.head, "\n", false);
	}

	private dispatchAutolink(
		view: EditorView,
		absStart: number,
		replaceEnd: number,
		insert: string,
		preserveCursor: boolean
	) {
		const oldText = view.state.doc.sliceString(absStart, replaceEnd);
		view.dispatch({
			changes: { from: absStart, to: replaceEnd, insert },
			...(preserveCursor
				? {}
				: { selection: { anchor: absStart + insert.length } }),
		});
		// Recorded after dispatching: the update listener clears any previous
		// record on doc changes, then we install the fresh one.
		this.lastAutolink = {
			view,
			time: Date.now(),
			from: absStart,
			to: replaceEnd,
			text: oldText,
		};
	}

	private tryAutolinkBeforeCursor(
		view: EditorView,
		pos: number,
		trailing: string,
		setupPendingUndo: boolean,
		replaceTo?: number,
		preserveCursor = false
	): boolean {
		const state = view.state;
		const line = state.doc.lineAt(pos);
		const colOffset = pos - line.from;
		const textBefore = line.text.substring(0, colOffset);
		const replaceEnd = replaceTo ?? pos;

		if (!textBefore.length) return false;
		if (this.isInCodeContext(view, pos, line.text, colOffset)) return false;
		if (this.isInsideWikilink(textBefore)) return false;
		// An active note search owns its query: spaces and punctuation are
		// part of what the user is filtering for, so the auto-linker must not
		// grab words out of it (it would inject [[..]] into the query and
		// kill the popup). The search resolves via the popup instead.
		if (
			this.settings.noteSearchEnabled &&
			this.matchNoteSearchPrefix(textBefore)
		)
			return false;

		const urlMatch = this.matchUrlAtEnd(textBefore);
		if (urlMatch) {
			const absStart = line.from + urlMatch.start;
			const insert =
				this.formatUrlAsMarkdownLink(urlMatch.url) + trailing;
			this.dispatchAutolink(
				view,
				absStart,
				replaceEnd,
				insert,
				preserveCursor
			);
			return true;
		}

		const alias = this.matchAlias(textBefore);
		if (alias) {
			const file = this.app.workspace.getActiveFile();
			if (file && this.normalize(alias.target) === this.normalize(file.basename))
				return false;
			const absStart = line.from + alias.start;
			const t = sanitize(alias.target);
			const d = sanitize(alias.displayText);
			const insert = `[[${t}|${d}]]${trailing}`;
			this.dispatchAutolink(
				view,
				absStart,
				replaceEnd,
				insert,
				preserveCursor
			);
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
			this.dispatchAutolink(
				view,
				absStart,
				replaceEnd,
				insert,
				preserveCursor
			);

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
		// While composing, bulk events are the keyboard's own word updates.
		// Transforming them mid-composition desynchronizes the keyboard, so
		// let the commit land untouched and transform it after it settles.
		if (this.isImeActive(view)) {
			this.scheduleDeferredBulk(view, from, text);
			return false;
		}

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
		// The keyboard believes its own text now occupies
		// [from, from + text.length); remember that so a stale re-commit of
		// (part of) it is recognized and swallowed.
		this.lastAutolink = {
			view,
			time: Date.now(),
			from,
			to: from + text.length,
			text,
		};
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
				const urlMatch = this.matchUrlInText(text, i, "");
				if (urlMatch) {
					result.push(
						this.settings.urlAutolinkEnabled
							? this.formatUrlAsMarkdownLink(urlMatch.url)
							: urlMatch.url
					);
					i = urlMatch.end;
					continue;
				}
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
				const bareUrl = this.matchUrlInText(text, i, prevChar);
				if (bareUrl) {
					result.push(this.formatUrlAsMarkdownLink(bareUrl.url));
					i = bareUrl.end;
					continue;
				}
			}

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

	private isImeActive(view: EditorView): boolean {
		return view.composing || view.compositionStarted;
	}

	// After we turn typed text into a link, mobile keyboards may re-send the
	// word they just committed ("GmbH" → "GmbH") using document positions from
	// BEFORE our dispatch inserted "[[". Detect such re-commits by comparing
	// the incoming replacement against the recorded pre-link text at the same
	// (pre-link) coordinates; they carry no new information and must not be
	// applied to the shifted document.
	private isStaleRecommit(
		view: EditorView,
		from: number,
		to: number,
		text: string
	): boolean {
		const rec = this.lastAutolink;
		if (!rec) return false;
		if (rec.view !== view) return false;
		if (Date.now() - rec.time > 2000) return false;
		if (from >= to || from < rec.from) return false;

		let t = text;
		let end = to;
		// Tolerate the trigger space being included in the re-commit.
		if (t.endsWith(" ")) {
			if (end === rec.to + 1) {
				end--;
				t = t.substring(0, t.length - 1);
			} else if (t.length === end - from + 1) {
				t = t.substring(0, t.length - 1);
			}
		}
		if (end > rec.to) return false;
		if (!t.length || t.length !== end - from) return false;

		const old = rec.text.substring(from - rec.from, end - rec.from);
		return this.normalize(t) === this.normalize(old);
	}

	private isStaleSpaceInsert(view: EditorView, from: number): boolean {
		const rec = this.lastAutolink;
		return (
			!!rec &&
			rec.view === view &&
			Date.now() - rec.time <= 2000 &&
			from === rec.to
		);
	}

	// Expected post-input document content ending at (and including) the
	// trigger, used to revalidate a deferred autolink. `applied` is the text
	// the pending default input will insert; it must end with the trigger.
	private static deferredContext(prefix: string, applied: string): string {
		const s = prefix + applied;
		return s.substring(Math.max(0, s.length - 32));
	}

	private static isTriggerChar(ch: string): boolean {
		return (
			ch === " " ||
			ch === "\n" ||
			AutoLinkKeywordsPlugin.PUNCTUATION_TRIGGERS.includes(ch)
		);
	}

	private scheduleDeferredAutolink(
		view: EditorView,
		from: number,
		trigger: string,
		setupPendingUndo: boolean,
		context: string
	) {
		this.enqueueDeferred({
			kind: "trigger",
			view,
			from,
			trigger,
			setupPendingUndo,
			context,
			tries: 0,
			timer: 0,
		});
	}

	private scheduleDeferredBulk(view: EditorView, from: number, text: string) {
		if (!text || text.length > 10000) return;
		this.enqueueDeferred({
			kind: "bulk",
			view,
			from,
			text,
			tries: 0,
			timer: 0,
		});
	}

	private enqueueDeferred(d: DeferredAutolink) {
		if (this.deferredAutolinks.length >= 8) {
			const dropped = this.deferredAutolinks.shift();
			if (dropped) window.clearTimeout(dropped.timer);
		}
		this.deferredAutolinks.push(d);
		d.timer = window.setTimeout(() => this.runDeferred(d), 50);
	}

	private runDeferred(d: DeferredAutolink) {
		const idx = this.deferredAutolinks.indexOf(d);
		if (idx === -1) return;

		if (this.isImeActive(d.view)) {
			if (d.tries < 20) {
				d.tries++;
				d.timer = window.setTimeout(() => this.runDeferred(d), 50);
			} else {
				// Rather link nothing than dispatch into a composition that
				// refuses to end — a missed link is recoverable, a
				// desynchronized keyboard corrupts text.
				this.deferredAutolinks.splice(idx, 1);
			}
			return;
		}

		this.deferredAutolinks.splice(idx, 1);
		try {
			if (d.kind === "trigger") {
				this.fireDeferredTrigger(d);
			} else {
				this.fireDeferredBulk(d);
			}
		} catch {
			// The view may have been detached while the timer was pending.
		}
	}

	private fireDeferredTrigger(d: DeferredTrigger) {
		const state = d.view.state;
		const end = d.from + d.trigger.length;
		const start = end - d.context.length;
		// The document may have changed while we waited (late keyboard
		// commits, further typing, even a file switch in this pane); only
		// proceed if the surroundings still match what we captured.
		if (start < 0 || end > state.doc.length) return;
		if (state.doc.sliceString(start, end) !== d.context) return;

		const sel = state.selection.main;
		const cursorAtTrigger = sel.empty && sel.head === end;
		this.tryAutolinkBeforeCursor(
			d.view,
			d.from,
			d.trigger,
			d.setupPendingUndo && cursorAtTrigger,
			end,
			!cursorAtTrigger
		);
	}

	private fireDeferredBulk(d: DeferredBulk) {
		const state = d.view.state;
		const end = d.from + d.text.length;
		if (d.from < 0 || end > state.doc.length) return;
		// Only proceed if the committed text still stands unchanged.
		if (state.doc.sliceString(d.from, end) !== d.text) return;

		const line = state.doc.lineAt(d.from);
		const colOffset = d.from - line.from;
		if (this.isInCodeContext(d.view, d.from, line.text, colOffset))
			return;
		if (this.isInsideWikilink(line.text.substring(0, colOffset))) return;

		const file = this.app.workspace.getActiveFile();
		const selfName = file?.basename ?? "";
		let regionEnd = end;
		let finalText = d.text;

		// Pass 1: transform the committed range itself, linking every
		// keyword/URL inside it (dictated sentences, swiped words).
		if (this.entries.length > 0) {
			const charBefore =
				d.from > 0 ? state.doc.sliceString(d.from - 1, d.from) : "";
			const charAfter =
				end < state.doc.length
					? state.doc.sliceString(end, end + 1)
					: "";
			const replaced = this.replaceKeywordsInText(
				d.text,
				charBefore,
				charAfter,
				selfName
			);
			if (replaced !== d.text) {
				const sel = state.selection.main;
				const cursorAtEnd = sel.empty && sel.head === end;
				d.view.dispatch({
					changes: { from: d.from, to: end, insert: replaced },
					...(cursorAtEnd
						? { selection: { anchor: d.from + replaced.length } }
						: {}),
				});
				this.lastAutolink = {
					view: d.view,
					time: Date.now(),
					from: d.from,
					to: end,
					text: d.text,
				};
				regionEnd = d.from + replaced.length;
				finalText = replaced;
			}
		}

		// Pass 2: a keyword may span the commit boundary (e.g. "UL Dash "
		// already in the document, "GmbH " committed) — link it via the
		// regular line-based matcher at the trailing trigger character.
		const last = finalText.charAt(finalText.length - 1);
		if (AutoLinkKeywordsPlugin.isTriggerChar(last)) {
			const sel = d.view.state.selection.main;
			const cursorAtEnd = sel.empty && sel.head === regionEnd;
			this.tryAutolinkBeforeCursor(
				d.view,
				regionEnd - 1,
				last,
				false,
				regionEnd,
				!cursorAtEnd
			);
		}
	}

	private cancelDeferredAutolinks() {
		for (const d of this.deferredAutolinks) {
			window.clearTimeout(d.timer);
		}
		this.deferredAutolinks = [];
	}

	startPeriodicRelink() {
		this.stopPeriodicRelink();
		if (!this.settings.periodicRelink) return;
		const ms = this.settings.periodicRelinkIntervalMinutes * 60 * 1000;
		this.relinkTimer = window.setInterval(() => {
			void this.relinkVault(false);
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
			void this.relinkVault(false);
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
				const fm = cache.frontmatter as Record<string, unknown>;
				const raw: unknown = fm.aliases ?? fm.alias;
				const aliasList: unknown[] = Array.isArray(raw)
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

	parseTlds() {
		this.tldSet.clear();
		for (const raw of this.settings.urlAutolinkTlds.split("\n")) {
			const tld = raw.trim().toLowerCase().replace(/^\./, "");
			if (tld && /^[a-z0-9-]+$/.test(tld)) {
				this.tldSet.add(tld);
			}
		}
	}

	private static URL_CHAR_RE = /[A-Za-z0-9.\-/:?#=&%+_~]/;
	private static BARE_DOMAIN_RE =
		/^([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+)(\/[^\s]*)?$/i;

	private formatUrlAsMarkdownLink(url: string): string {
		let target = url;
		if (!/^https?:\/\//i.test(target)) {
			target = "https://" + target;
		}

		let display = url
			.replace(/^https?:\/\//i, "")
			.replace(/^www\./i, "");

		const qIdx = display.indexOf("?");
		if (qIdx >= 0) display = display.substring(0, qIdx);
		const hIdx = display.indexOf("#");
		if (hIdx >= 0) display = display.substring(0, hIdx);
		display = display.replace(/\/+$/, "");

		display = display.replace(/[\]\\]/g, "");
		target = target.replace(/[)\s]/g, (c) => encodeURIComponent(c));

		return `[${display}](${target})`;
	}

	private matchUrlAtEnd(
		textBefore: string
	): { start: number; url: string } | null {
		if (!this.settings.urlAutolinkEnabled) return null;
		if (!textBefore.length) return null;

		let start = textBefore.length;
		while (start > 0) {
			const ch = textBefore.charAt(start - 1);
			if (!AutoLinkKeywordsPlugin.URL_CHAR_RE.test(ch)) break;
			start--;
		}
		if (start === textBefore.length) return null;

		if (start > 0) {
			const boundary = textBefore.charAt(start - 1);
			if (boundary === "(" || boundary === "[") return null;
		}

		const candidate = textBefore.substring(start);

		if (/^https?:\/\//i.test(candidate)) {
			const m = candidate.match(/^https?:\/\/([^/?#]+)/i);
			const host = m && m[1];
			if (!host) return null;
			const lastDot = host.lastIndexOf(".");
			if (lastDot <= 0) return null;
			const tld = host.substring(lastDot + 1).toLowerCase();
			if (!/^[a-z0-9-]+$/.test(tld)) return null;
			return { start, url: candidate };
		}

		const m = candidate.match(AutoLinkKeywordsPlugin.BARE_DOMAIN_RE);
		const domainPart = m && m[1];
		if (!domainPart) return null;
		const lastDot = domainPart.lastIndexOf(".");
		const tld = domainPart.substring(lastDot + 1).toLowerCase();
		if (!this.tldSet.has(tld)) return null;

		return { start, url: candidate };
	}

	private matchUrlInText(
		text: string,
		i: number,
		prevChar: string
	): { url: string; end: number } | null {
		if (!this.settings.urlAutolinkEnabled) return null;

		const isProtocol =
			text.substring(i, i + 7).toLowerCase() === "http://" ||
			text.substring(i, i + 8).toLowerCase() === "https://";

		if (isProtocol) {
			let end = i;
			while (
				end < text.length &&
				!/\s/.test(text.charAt(end)) &&
				text.charAt(end) !== ")" &&
				text.charAt(end) !== "]"
			)
				end++;
			let url = text.substring(i, end);
			while (url.length > 0 && /[.,;:!?]/.test(url.charAt(url.length - 1))) {
				url = url.substring(0, url.length - 1);
				end--;
			}
			const m = url.match(/^https?:\/\/([^/?#]+)/i);
			const host = m && m[1];
			if (!host) return null;
			const lastDot = host.lastIndexOf(".");
			if (lastDot <= 0) return null;
			const tld = host.substring(lastDot + 1).toLowerCase();
			if (!/^[a-z0-9-]+$/.test(tld)) return null;
			return { url, end };
		}

		if (prevChar && /[\p{L}\p{N}]/u.test(prevChar)) return null;

		const firstCh = text.charAt(i);
		if (!/[a-zA-Z0-9]/.test(firstCh)) return null;

		let end = i;
		while (
			end < text.length &&
			AutoLinkKeywordsPlugin.URL_CHAR_RE.test(text.charAt(end))
		)
			end++;
		let url = text.substring(i, end);
		while (url.length > 0 && /[.,;:!?]/.test(url.charAt(url.length - 1))) {
			url = url.substring(0, url.length - 1);
			end--;
		}
		if (!url) return null;

		const m = url.match(AutoLinkKeywordsPlugin.BARE_DOMAIN_RE);
		const domainPart = m && m[1];
		if (!domainPart) return null;
		const lastDot = domainPart.lastIndexOf(".");
		const tld = domainPart.substring(lastDot + 1).toLowerCase();
		if (!this.tldSet.has(tld)) return null;

		return { url, end };
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

	// Longer delimiter first, so a triple-slash input is never claimed by the
	// double-slash rule when one delimiter is a substring of the other.
	private aliasChecks(): { kind: "single" | "multi"; delim: string }[] {
		const sw = this.settings.singleWordDelimiter;
		const mw = this.settings.multiWordDelimiter;
		if (sw.length > mw.length) {
			return [
				{ kind: "single", delim: sw },
				{ kind: "multi", delim: mw },
			];
		}
		return [
			{ kind: "multi", delim: mw },
			{ kind: "single", delim: sw },
		];
	}

	private matchAlias(
		textBefore: string
	): { displayText: string; target: string; start: number } | null {
		for (const check of this.aliasChecks()) {
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

	// ---- Alias target suggestions (issue #10) ----
	// Same shape as matchAlias(), but the target may still be half-typed, so
	// there is no lookup — the partial target becomes the popup query instead.

	private matchAliasPrefix(
		textBefore: string
	): { start: number; displayText: string; query: string } | null {
		for (const check of this.aliasChecks()) {
			const result =
				check.kind === "multi"
					? this.matchMultiWordAliasPrefix(textBefore, check.delim)
					: this.matchSingleWordAliasPrefix(textBefore, check.delim);
			if (result) return result;
		}
		return null;
	}

	private matchSingleWordAliasPrefix(
		textBefore: string,
		delim: string
	): { start: number; displayText: string; query: string } | null {
		const idx = textBefore.lastIndexOf(delim);
		if (idx === -1) return null;
		if (idx > 0 && textBefore.charAt(idx - 1) === ":") return null;

		const query = textBefore.substring(idx + delim.length);
		if (/\s/.test(query)) return null;

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

		return { start: displayStart, displayText, query };
	}

	private matchMultiWordAliasPrefix(
		textBefore: string,
		delim: string
	): { start: number; displayText: string; query: string } | null {
		const secondIdx = textBefore.lastIndexOf(delim);
		if (secondIdx === -1) return null;

		const query = textBefore.substring(secondIdx + delim.length);
		if (/\s/.test(query)) return null;

		const beforeSecond = textBefore.substring(0, secondIdx);
		const firstIdx = beforeSecond.lastIndexOf(delim);
		if (firstIdx === -1) return null;
		if (firstIdx > 0 && textBefore.charAt(firstIdx - 1) === ":") return null;

		const displayText = beforeSecond.substring(firstIdx + delim.length);
		if (!displayText) return null;

		if (textBefore.substring(firstIdx, firstIdx + 2) === "[[")
			return null;

		return { start: firstIdx, displayText, query };
	}

	// Finds a note-search trigger (default ";;") in the typed text. The query
	// may contain spaces so multi-part names like "T-Rex - Feeding Schedule"
	// stay reachable; a query that starts with whitespace is ordinary text
	// (with the trigger set to "*", list bullets must never open the popup).
	private matchNoteSearchPrefix(
		textBefore: string
	): { start: number; query: string } | null {
		const trigger = this.settings.noteSearchTrigger;
		if (!trigger) return null;
		const idx = textBefore.lastIndexOf(trigger);
		if (idx === -1) return null;
		const before = idx > 0 ? textBefore.charAt(idx - 1) : "";
		if (/[\p{L}\p{N}]/u.test(before)) return null;
		if (before === trigger.charAt(0)) return null;

		const query = textBefore.substring(idx + trigger.length);
		if (/^\s/.test(query)) return null;
		if (query.includes("[[")) return null;
		if (query.length > 60) return null;

		return { start: idx, query };
	}

	getAliasSuggestTrigger(
		cursor: EditorPosition,
		editor: Editor
	):
		| (EditorSuggestTriggerInfo & {
				displayText: string;
				mode: SuggestMode;
		  })
		| null {
		if (
			!this.settings.aliasSuggestEnabled &&
			!this.settings.noteSearchEnabled
		)
			return null;

		const line = editor.getLine(cursor.line);
		const textBefore = line.substring(0, cursor.ch);
		if (!textBefore) return null;

		// The CM6 view behind the Obsidian editor is not part of the public
		// API; without it the composition and code-context checks are skipped.
		const view = (editor as unknown as { cm?: EditorView }).cm;
		if (view && this.isImeActive(view)) return null;
		if (this.isInsideWikilink(textBefore)) return null;
		if (
			view &&
			this.isInCodeContext(
				view,
				editor.posToOffset(cursor),
				line,
				cursor.ch
			)
		)
			return null;

		if (this.settings.aliasSuggestEnabled) {
			const prefix = this.matchAliasPrefix(textBefore);
			if (prefix)
				return {
					start: { line: cursor.line, ch: prefix.start },
					end: cursor,
					query: prefix.query,
					displayText: prefix.displayText,
					mode: "alias",
				};
		}

		if (this.settings.noteSearchEnabled) {
			const search = this.matchNoteSearchPrefix(textBefore);
			if (search)
				return {
					start: { line: cursor.line, ch: search.start },
					end: cursor,
					query: search.query,
					displayText: "",
					mode: "search",
				};
		}

		return null;
	}

	getAliasSuggestions(
		query: string,
		activeFile: TFile | null
	): AliasSuggestion[] {
		const selfNorm = activeFile
			? this.normalize(activeFile.basename)
			: null;
		const candidates = this.entries.filter(
			(e) => selfNorm === null || this.normalize(e.target) !== selfNorm
		);

		if (!query) {
			return candidates
				.sort((a, b) => a.keyword.localeCompare(b.keyword))
				.map((entry) => ({ entry, match: null }));
		}

		const fuzzy = prepareFuzzySearch(query);
		const scored: { entry: KeywordEntry; match: SearchResult }[] = [];
		for (const entry of candidates) {
			const match = fuzzy(entry.keyword);
			if (match) scored.push({ entry, match });
		}
		scored.sort((a, b) => b.match.score - a.match.score);
		return scored;
	}

	// displayText null means note-search mode: the typed query was only a
	// filter and is replaced entirely, mirroring the keyword-autolink format
	// (mapping entries keep their keyword as alias).
	applyAliasSuggestion(
		context: EditorSuggestContext,
		entry: KeywordEntry,
		displayText: string | null
	) {
		const t = sanitize(entry.target);
		if (!t) return;
		let insert: string;
		if (displayText === null) {
			const kw = sanitize(entry.keyword);
			if (!kw) return;
			insert =
				kw.toLowerCase() === t.toLowerCase()
					? `[[${t}]]`
					: `[[${t}|${kw}]]`;
		} else {
			const d = sanitize(displayText);
			if (!d) return;
			insert = `[[${t}|${d}]]`;
		}

		const editor = context.editor;
		const view = (editor as unknown as { cm?: EditorView }).cm;
		if (view) {
			// dispatchAutolink also records the replacement, which keeps the
			// stale IME/autocorrect re-commit protection working for links
			// created through the popup.
			this.dispatchAutolink(
				view,
				editor.posToOffset(context.start),
				editor.posToOffset(context.end),
				insert,
				false
			);
		} else {
			editor.replaceRange(insert, context.start, context.end);
			editor.setCursor({
				line: context.start.line,
				ch: context.start.ch + insert.length,
			});
		}
	}

	private matchAliasInText(
		text: string,
		pos: number,
		skipNorm?: string
	): { replacement: string; end: number } | null {
		for (const check of this.aliasChecks()) {
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
			void this.saveSettings();
			this.saveTimer = null;
		}, 500);
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<AutoLinkSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
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
		if (typeof this.settings.aliasSuggestEnabled !== "boolean")
			this.settings.aliasSuggestEnabled = DEFAULT_SETTINGS.aliasSuggestEnabled;
		if (typeof this.settings.aliasSuggestEnterAccepts !== "boolean")
			this.settings.aliasSuggestEnterAccepts = DEFAULT_SETTINGS.aliasSuggestEnterAccepts;
		if (typeof this.settings.aliasSuggestTabAccepts !== "boolean")
			this.settings.aliasSuggestTabAccepts = DEFAULT_SETTINGS.aliasSuggestTabAccepts;
		if (typeof this.settings.noteSearchEnabled !== "boolean")
			this.settings.noteSearchEnabled = DEFAULT_SETTINGS.noteSearchEnabled;
		if (typeof this.settings.noteSearchTrigger !== "string" || !this.settings.noteSearchTrigger)
			this.settings.noteSearchTrigger = DEFAULT_SETTINGS.noteSearchTrigger;
		if (typeof this.settings.urlAutolinkEnabled !== "boolean")
			this.settings.urlAutolinkEnabled = DEFAULT_SETTINGS.urlAutolinkEnabled;
		if (typeof this.settings.urlAutolinkTlds !== "string")
			this.settings.urlAutolinkTlds = DEFAULT_SETTINGS.urlAutolinkTlds;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.parseBlocklist();
		this.parseManualKeywords();
		this.parseTlds();
		if (this.settings.scanVaultLinks) {
			this.scheduleScan();
		}
	}
}

interface AliasSuggestion {
	entry: KeywordEntry;
	match: SearchResult | null;
}

type SuggestMode = "alias" | "search";

class AliasTargetSuggest extends EditorSuggest<AliasSuggestion> {
	private plugin: AutoLinkKeywordsPlugin;
	private displayText = "";
	private mode: SuggestMode = "alias";
	private pill: HTMLElement | null = null;
	private pillObserver: MutationObserver | null = null;
	visible = false;

	constructor(app: App, plugin: AutoLinkKeywordsPlugin) {
		super(app);
		this.plugin = plugin;
		this.limit = 12;
		this.rebindEnter();
		this.scope.register([], "Tab", (evt: KeyboardEvent) => {
			if (!this.plugin.settings.aliasSuggestTabAccepts) return true;
			return this.acceptSelected(evt);
		});
	}

	// Whether an Enter keypress will be consumed by the open popup. When the
	// user turned Enter acceptance off (or rebinding failed and the stock
	// binding is active), the editor's own Enter handling stays in charge.
	consumesEnter(): boolean {
		if (!this.visible) return false;
		if (!this.enterRebound) return true;
		return this.plugin.settings.aliasSuggestEnterAccepts;
	}

	private enterRebound = false;

	// The chooser registers its Enter binding on the popover scope during
	// construction. Swap it for a setting-aware one so Enter can be released
	// back to the editor. The handler list is not public API — when it is
	// missing, the stock binding stays and Enter always accepts.
	private rebindEnter(): void {
		const scope = this.scope as unknown as { keys?: KeymapEventHandler[] };
		if (!Array.isArray(scope.keys)) return;
		const builtin = scope.keys.filter((h) => h && h.key === "Enter");
		if (!builtin.length) return;
		for (const handler of builtin) this.scope.unregister(handler);
		this.enterRebound = true;
		this.scope.register([], "Enter", (evt: KeyboardEvent) => {
			if (!this.plugin.settings.aliasSuggestEnterAccepts) return true;
			return this.acceptSelected(evt);
		});
	}

	// Applies the highlighted suggestion via the chooser. Returns false
	// (event handled) when a suggestion was used, true to let the key fall
	// through to the editor.
	private acceptSelected(evt: KeyboardEvent): boolean {
		const chooser = (
			this as unknown as {
				suggestions?: {
					useSelectedItem?: (evt: KeyboardEvent) => boolean;
				};
			}
		).suggestions;
		if (!chooser?.useSelectedItem) return true;
		return chooser.useSelectedItem(evt) ? false : true;
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor
	): EditorSuggestTriggerInfo | null {
		const trigger = this.plugin.getAliasSuggestTrigger(cursor, editor);
		if (!trigger) return null;
		this.displayText = trigger.displayText;
		this.mode = trigger.mode;
		return trigger;
	}

	getSuggestions(context: EditorSuggestContext): AliasSuggestion[] {
		return this.plugin.getAliasSuggestions(
			context.query,
			context.file ?? null
		);
	}

	renderSuggestion(suggestion: AliasSuggestion, el: HTMLElement): void {
		el.addClass("linkosaurus-suggest-item");

		const chip = el.createDiv({ cls: "linkosaurus-suggest-chip" });
		setIcon(chip, "link");

		const body = el.createDiv({ cls: "linkosaurus-suggest-body" });
		const title = body.createDiv({ cls: "linkosaurus-suggest-title" });
		if (suggestion.match) {
			renderMatches(
				title,
				suggestion.entry.keyword,
				suggestion.match.matches
			);
		} else {
			title.setText(suggestion.entry.keyword);
		}
		if (suggestion.entry.target !== suggestion.entry.keyword) {
			body.createDiv({
				cls: "linkosaurus-suggest-sub",
				text: `→ ${suggestion.entry.target}`,
			});
		}
	}

	selectSuggestion(suggestion: AliasSuggestion): void {
		const context = this.context;
		if (!context) return;
		this.plugin.applyAliasSuggestion(
			context,
			suggestion.entry,
			this.mode === "search" ? null : this.displayText
		);
		this.close();
	}

	open(): void {
		const instructions = [{ command: "↑↓", purpose: "navigate" }];
		if (!this.enterRebound || this.plugin.settings.aliasSuggestEnterAccepts)
			instructions.push({ command: "↵", purpose: "link" });
		if (this.plugin.settings.aliasSuggestTabAccepts)
			instructions.push({ command: "⇥", purpose: "link" });
		instructions.push({ command: "esc", purpose: "dismiss" });
		this.setInstructions(instructions);

		super.open();
		this.visible = true;
		this.installPill();
	}

	close(): void {
		super.close();
		this.visible = false;
		this.removePill();
	}

	// The popover element is not part of the public API; when it is missing,
	// the popup silently falls back to Obsidian's default look.
	private popoverEl(): HTMLElement | null {
		const el = (this as unknown as { suggestEl?: HTMLElement }).suggestEl;
		return el instanceof HTMLElement ? el : null;
	}

	private installPill(): void {
		const popover = this.popoverEl();
		if (!popover) return;
		popover.addClass("linkosaurus-alias-suggest");

		const list = popover.querySelector(".suggestion");
		if (!(list instanceof HTMLElement)) return;

		this.pill = createDiv({ cls: "linkosaurus-suggest-pill" });
		list.prepend(this.pill);

		// Obsidian rebuilds the item elements on every keystroke and moves the
		// selection class around; both arrive here as mutations.
		this.pillObserver = new MutationObserver(() => this.movePill(list));
		this.pillObserver.observe(list, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["class"],
		});
		this.movePill(list);
	}

	private movePill(list: HTMLElement): void {
		if (!this.pill) return;
		if (!this.pill.isConnected) list.prepend(this.pill);

		const selected = list.querySelector(".suggestion-item.is-selected");
		if (!(selected instanceof HTMLElement)) {
			this.pill.setCssStyles({ opacity: "0" });
			return;
		}
		this.pill.setCssStyles({
			opacity: "1",
			transform: `translateY(${selected.offsetTop}px)`,
			height: `${selected.offsetHeight}px`,
		});
	}

	private removePill(): void {
		this.pillObserver?.disconnect();
		this.pillObserver = null;
		this.pill?.remove();
		this.pill = null;
	}
}

class AutoLinkSettingTab extends PluginSettingTab {
	plugin: AutoLinkKeywordsPlugin;

	constructor(app: App, plugin: AutoLinkKeywordsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Declarative settings for Obsidian 1.13+: rendered by the framework and
	// indexed by the global settings search. Values are read from
	// plugin.settings by the default getControlValue; writes flow through
	// setControlValue below. Textareas stay imperative render rows so they
	// keep their monospace styling and debounced parsing.
	getSettingDefinitions(): SettingDefinitionItem[] {
		const plugin = this.plugin;
		const vaultScanOn = () => plugin.settings.scanVaultLinks;

		const monoTextArea = (
			setting: Setting,
			opts: {
				name: string;
				desc?: string;
				rows: number;
				placeholder?: string;
				value: () => string;
				onChange: (value: string) => void;
			}
		) => {
			setting.setName(opts.name);
			if (opts.desc) setting.setDesc(opts.desc);
			setting
				.setClass("linkosaurus-textarea-mono")
				.addTextArea((text) => {
					text.inputEl.rows = opts.rows;
					if (opts.placeholder) text.setPlaceholder(opts.placeholder);
					text.setValue(opts.value()).onChange(opts.onChange);
				});
		};

		return [
			{
				name: "Keyword list syntax",
				searchable: false,
				render: (setting: Setting) => {
					setting.settingEl.empty();
					setting.settingEl.addClass("linkosaurus-desc");
					this.buildIntro(setting.settingEl);
				},
			},
			{
				name: "Keyword list",
				aliases: ["keywords", "manual keywords"],
				render: (setting: Setting) =>
					monoTextArea(setting, {
						name: "Keyword list",
						rows: 28,
						value: () => plugin.settings.keywordList,
						onChange: (value) => {
							plugin.settings.keywordList = value;
							plugin.parseManualKeywords();
							plugin.debouncedSave();
						},
					}),
			},
			{
				name: "Case-insensitive matching",
				desc: "Match keywords regardless of upper/lower case.",
				control: {
					type: "toggle",
					key: "caseInsensitive",
					defaultValue: DEFAULT_SETTINGS.caseInsensitive,
				},
			},
			{
				name: "Single-word alias delimiter",
				desc:
					"Delimiter between display text and keyword for single-word aliases. " +
					"Example: trip//Tokyo → [[Tokyo|trip]]",
				aliases: ["alias"],
				control: {
					type: "text",
					key: "singleWordDelimiter",
					defaultValue: DEFAULT_SETTINGS.singleWordDelimiter,
					placeholder: "//",
					validate: (value: string) => {
						if (!value) return "The delimiter cannot be empty.";
						if (value === plugin.settings.multiWordDelimiter)
							return "Single-word and multi-word delimiters must be different.";
						if (value === plugin.settings.noteSearchTrigger)
							return "The delimiter must differ from the search trigger.";
						return;
					},
				},
			},
			{
				name: "Multi-word alias delimiter",
				desc:
					"Delimiter that wraps display text for multi-word aliases. " +
					"Example: ///cherry blossoms///Tokyo → [[Tokyo|cherry blossoms]]",
				aliases: ["alias"],
				control: {
					type: "text",
					key: "multiWordDelimiter",
					defaultValue: DEFAULT_SETTINGS.multiWordDelimiter,
					placeholder: "///",
					validate: (value: string) => {
						if (!value) return "The delimiter cannot be empty.";
						if (value === plugin.settings.singleWordDelimiter)
							return "Single-word and multi-word delimiters must be different.";
						if (value === plugin.settings.noteSearchTrigger)
							return "The delimiter must differ from the search trigger.";
						return;
					},
				},
			},
			{
				name: "Alias target suggestions",
				desc:
					"While typing the target part of an alias (e.g. trip//To), " +
					"show a popup suggesting matching targets. Selecting one " +
					"creates the link immediately.",
				aliases: ["autocomplete", "popup", "suggestions"],
				control: {
					type: "toggle",
					key: "aliasSuggestEnabled",
					defaultValue: DEFAULT_SETTINGS.aliasSuggestEnabled,
				},
			},
			{
				name: "Note search popup",
				desc:
					"Type the search trigger to open a popup listing every " +
					"linkable note and keyword, filtering as you type — " +
					"spaces allowed. Example: ;;feed → [[T-Rex - Feeding Schedule]]",
				aliases: ["search", "quick", "popup"],
				control: {
					type: "toggle",
					key: "noteSearchEnabled",
					defaultValue: DEFAULT_SETTINGS.noteSearchEnabled,
				},
			},
			{
				name: "Search trigger",
				desc: "Characters that open the note search popup.",
				aliases: ["search", "trigger"],
				visible: () => plugin.settings.noteSearchEnabled,
				control: {
					type: "text",
					key: "noteSearchTrigger",
					defaultValue: DEFAULT_SETTINGS.noteSearchTrigger,
					placeholder: ";;",
					validate: (value: string) => {
						if (!value) return "The trigger cannot be empty.";
						if (
							value === plugin.settings.singleWordDelimiter ||
							value === plugin.settings.multiWordDelimiter
						)
							return "The trigger must differ from the alias delimiters.";
						return;
					},
				},
			},
			{
				name: "Accept suggestion with Enter",
				desc:
					"Pressing Enter links the highlighted suggestion. Turn off " +
					"to keep Enter for line breaks even while the popup is open.",
				aliases: ["enter", "keybinding"],
				visible: () =>
					plugin.settings.aliasSuggestEnabled ||
					plugin.settings.noteSearchEnabled,
				control: {
					type: "toggle",
					key: "aliasSuggestEnterAccepts",
					defaultValue: DEFAULT_SETTINGS.aliasSuggestEnterAccepts,
				},
			},
			{
				name: "Accept suggestion with Tab",
				desc: "Pressing Tab links the highlighted suggestion.",
				aliases: ["tab", "keybinding"],
				visible: () =>
					plugin.settings.aliasSuggestEnabled ||
					plugin.settings.noteSearchEnabled,
				control: {
					type: "toggle",
					key: "aliasSuggestTabAccepts",
					defaultValue: DEFAULT_SETTINGS.aliasSuggestTabAccepts,
				},
			},
			{
				name: "Auto-detect vault links",
				desc: "Automatically use all note names and existing wikilinks from the vault as keywords.",
				aliases: ["vault scan"],
				control: {
					type: "toggle",
					key: "scanVaultLinks",
					defaultValue: DEFAULT_SETTINGS.scanVaultLinks,
				},
			},
			{
				name: "Include frontmatter aliases",
				desc: "Use aliases defined in note frontmatter (aliases/alias field) as additional keywords.",
				visible: vaultScanOn,
				control: {
					type: "toggle",
					key: "scanFrontmatterAliases",
					defaultValue: DEFAULT_SETTINGS.scanFrontmatterAliases,
				},
			},
			{
				name: "Minimum keyword length",
				desc: "Ignore auto-detected keywords shorter than this (0 = no limit). Does not affect manual keywords.",
				visible: vaultScanOn,
				control: {
					type: "number",
					key: "minKeywordLength",
					defaultValue: DEFAULT_SETTINGS.minKeywordLength,
					min: 0,
					max: 50,
				},
			},
			{
				name: "Blocklist",
				desc: "Keywords to exclude from auto-linking (one per line). Does not affect manual keywords.",
				visible: vaultScanOn,
				render: (setting: Setting) =>
					monoTextArea(setting, {
						name: "Blocklist",
						desc: "Keywords to exclude from auto-linking (one per line). Does not affect manual keywords.",
						rows: 6,
						placeholder: "Home\nInbox\nDaily",
						value: () => plugin.settings.blocklist,
						onChange: (value) => {
							plugin.settings.blocklist = value;
							plugin.parseBlocklist();
							plugin.parseManualKeywords();
							plugin.debouncedSave();
						},
					}),
			},
			{
				name: "Folder filter mode",
				desc: "Choose whether the listed folders are excluded or are the only ones included.",
				visible: vaultScanOn,
				control: {
					type: "dropdown",
					key: "folderFilterMode",
					defaultValue: DEFAULT_SETTINGS.folderFilterMode,
					options: {
						exclude: "Exclude listed folders",
						include: "Include only listed folders",
					},
				},
			},
			{
				name: "Folder filter",
				desc: "Folders to include or exclude from vault scanning (one per line).",
				visible: vaultScanOn,
				render: (setting: Setting) =>
					monoTextArea(setting, {
						name: "Folder filter",
						desc: "Folders to include or exclude from vault scanning (one per line).",
						rows: 4,
						placeholder: "Templates\nDaily Notes",
						value: () => plugin.settings.folderFilter,
						onChange: (value) => {
							plugin.settings.folderFilter = value;
							plugin.debouncedSave();
						},
					}),
			},
			{
				type: "group",
				heading: "Periodic auto-relink",
				visible: vaultScanOn,
				items: [
					{
						name: "Enable periodic auto-relink",
						desc:
							"Periodically scan all notes and retroactively convert plain-text keywords to wikilinks. " +
							"Notes currently open in the editor are skipped to avoid cursor jumps.",
						control: {
							type: "toggle",
							key: "periodicRelink",
							defaultValue: DEFAULT_SETTINGS.periodicRelink,
						},
					},
					{
						name: "Relink interval (minutes)",
						desc: "How often to scan the vault for unlinkable keywords (1–60 minutes).",
						visible: () => plugin.settings.periodicRelink,
						control: {
							type: "number",
							key: "periodicRelinkIntervalMinutes",
							defaultValue:
								DEFAULT_SETTINGS.periodicRelinkIntervalMinutes,
							min: 1,
							max: 60,
						},
					},
				],
			},
			{
				name: "Auto-link website URLs",
				desc:
					"Convert URLs to Markdown links while typing or pasting. " +
					"Detects http(s)://... and bare domains (e.g. example.com).",
				visible: vaultScanOn,
				control: {
					type: "toggle",
					key: "urlAutolinkEnabled",
					defaultValue: DEFAULT_SETTINGS.urlAutolinkEnabled,
				},
			},
			{
				name: "URL top-level domains",
				desc:
					"TLDs to detect for bare domains (one per line, without leading dot). " +
					"Only affects bare domains — http(s):// URLs always link.",
				visible: () =>
					plugin.settings.scanVaultLinks &&
					plugin.settings.urlAutolinkEnabled,
				render: (setting: Setting) =>
					monoTextArea(setting, {
						name: "URL top-level domains",
						desc:
							"TLDs to detect for bare domains (one per line, without leading dot). " +
							"Only affects bare domains — http(s):// URLs always link.",
						rows: 6,
						placeholder: "de\ncom\norg",
						value: () => plugin.settings.urlAutolinkTlds,
						onChange: (value) => {
							plugin.settings.urlAutolinkTlds = value;
							plugin.parseTlds();
							plugin.debouncedSave();
						},
					}),
			},
			{
				name: "Auto-detected keywords",
				searchable: false,
				visible: vaultScanOn,
				render: (setting: Setting) => {
					setting.settingEl.empty();
					this.buildVaultDetails(setting.settingEl);
				},
			},
		];
	}

	// Re-evaluates visibility of declaratively defined settings. Only ever
	// reached on Obsidian 1.13+ (setControlValue is called by the declarative
	// renderer), where update() exists — older versions never get here, so
	// the guarded indirection keeps the plugin loadable on minAppVersion.
	private refreshDefinitions() {
		(this as { update?: () => void }).update?.();
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings as unknown as Record<
			string,
			unknown
		>;
		settings[key] = value;

		switch (key) {
			case "singleWordDelimiter":
			case "multiWordDelimiter": {
				await this.plugin.saveSettings();
				const sw = this.plugin.settings.singleWordDelimiter;
				const mw = this.plugin.settings.multiWordDelimiter;
				if (sw.includes(mw) || mw.includes(sw)) {
					new Notice(
						"Warning: one delimiter is a substring of the other. This may cause parsing conflicts."
					);
				}
				return;
			}
			case "periodicRelink":
				await this.plugin.saveSettings();
				if (value) {
					this.plugin.startPeriodicRelink();
				} else {
					this.plugin.stopPeriodicRelink();
				}
				this.refreshDefinitions();
				return;
			case "periodicRelinkIntervalMinutes":
				await this.plugin.saveSettings();
				this.plugin.startPeriodicRelink();
				return;
			case "aliasSuggestEnabled":
			case "scanVaultLinks":
			case "urlAutolinkEnabled":
				await this.plugin.saveSettings();
				this.refreshDefinitions();
				return;
			default:
				await this.plugin.saveSettings();
		}
	}

	private buildIntro(desc: HTMLElement) {
		desc.createSpan({
			text: "One keyword per line. Lines starting with ",
		});
		desc.createEl("code", { text: "#" });
		desc.createSpan({ text: " are comments." });
		desc.createEl("br");
		desc.createEl("code", { text: "London" });
		desc.createSpan({ text: " → " });
		desc.createEl("code", { text: "[[London]]" });
		desc.createEl("br");
		desc.createEl("code", { text: "ML = Machine Learning" });
		desc.createSpan({ text: " → " });
		desc.createEl("code", { text: "[[Machine Learning|ML]]" });
		desc.createEl("br");
		desc.createEl("br");
		desc.createEl("b", { text: "Single-word alias: " });
		desc.createEl("code", { text: "trip//keyword" });
		desc.createSpan({ text: " + Space → " });
		desc.createEl("code", { text: "[[target|trip]]" });
		desc.createEl("br");
		desc.createEl("b", { text: "Multi-word alias: " });
		desc.createEl("code", { text: "///cherry blossoms///keyword" });
		desc.createSpan({ text: " + Space → " });
		desc.createEl("code", { text: "[[target|cherry blossoms]]" });
		desc.createEl("br");
		desc.createSpan({ text: "Delimiters are configurable below." });
		desc.createEl("br");
		desc.createEl("br");
		desc.createEl("b", { text: "Shortcut: " });
		desc.createSpan({
			text: "select a word and use the ",
		});
		desc.createEl("em", {
			text: "Link selection and add to keyword list",
		});
		desc.createSpan({
			text: " command (assign a hotkey in Settings → Hotkeys).",
		});
	}

	private buildVaultDetails(containerEl: HTMLElement) {
		const vault = this.plugin.getVaultKeywords();
		const details = containerEl.createEl("details", {
			cls: "linkosaurus-details",
		});
		details.createEl("summary", {
			cls: "linkosaurus-details-summary",
			text: `Auto-detected keywords (${vault.length})`,
		});
		if (vault.length > 0) {
			details.createDiv({
				cls: "linkosaurus-details-list",
				text: vault.join("\n"),
			});
		}
	}

	// Fallback for Obsidian < 1.13; newer versions render from
	// getSettingDefinitions() and never call this.
	display() {
		const { containerEl } = this;
		containerEl.empty();

		this.buildIntro(containerEl.createDiv({ cls: "linkosaurus-desc" }));

		new Setting(containerEl)
			.setName("Keyword list")
			.setClass("linkosaurus-textarea-mono")
			.addTextArea((text) => {
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
				"Match keywords regardless of upper/lower case."
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
				"Example: trip//Tokyo → [[Tokyo|trip]]"
			)
			.setClass("linkosaurus-input-delim")
			.addText((text) => {
				const setError = (on: boolean) =>
					text.inputEl.toggleClass("linkosaurus-input-error", on);
				text.setPlaceholder("//")
					.setValue(this.plugin.settings.singleWordDelimiter)
					.onChange(async (value) => {
						if (!value) {
							setError(true);
							return;
						}
						if (value === this.plugin.settings.multiWordDelimiter) {
							setError(true);
							new Notice("Single-word and multi-word delimiters must be different.");
							return;
						}
						setError(false);
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
				"Example: ///cherry blossoms///Tokyo → [[Tokyo|cherry blossoms]]"
			)
			.setClass("linkosaurus-input-delim")
			.addText((text) => {
				const setError = (on: boolean) =>
					text.inputEl.toggleClass("linkosaurus-input-error", on);
				text.setPlaceholder("///")
					.setValue(this.plugin.settings.multiWordDelimiter)
					.onChange(async (value) => {
						if (!value) {
							setError(true);
							return;
						}
						if (value === this.plugin.settings.singleWordDelimiter) {
							setError(true);
							new Notice("Single-word and multi-word delimiters must be different.");
							return;
						}
						setError(false);
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
			.setName("Alias target suggestions")
			.setDesc(
				"While typing the target part of an alias (e.g. trip//To), " +
				"show a popup suggesting matching targets. Selecting one " +
				"creates the link immediately."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.aliasSuggestEnabled)
					.onChange(async (value) => {
						this.plugin.settings.aliasSuggestEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (this.plugin.settings.aliasSuggestEnabled) {
			new Setting(containerEl)
				.setName("Accept suggestion with Enter")
				.setDesc(
					"Pressing Enter links the highlighted suggestion. Turn off " +
					"to keep Enter for line breaks even while the popup is open."
				)
				.addToggle((toggle) => {
					toggle
						.setValue(this.plugin.settings.aliasSuggestEnterAccepts)
						.onChange(async (value) => {
							this.plugin.settings.aliasSuggestEnterAccepts = value;
							await this.plugin.saveSettings();
						});
				});

			new Setting(containerEl)
				.setName("Accept suggestion with Tab")
				.setDesc("Pressing Tab links the highlighted suggestion.")
				.addToggle((toggle) => {
					toggle
						.setValue(this.plugin.settings.aliasSuggestTabAccepts)
						.onChange(async (value) => {
							this.plugin.settings.aliasSuggestTabAccepts = value;
							await this.plugin.saveSettings();
						});
				});
		}

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
				.setClass("linkosaurus-input-number")
				.addText((text) => {
					text.inputEl.type = "number";
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
				.setClass("linkosaurus-textarea-mono")
				.addTextArea((text) => {
					text.inputEl.rows = 6;
					text.setPlaceholder("Home\nInbox\nDaily")
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
				.setClass("linkosaurus-textarea-mono")
				.addTextArea((text) => {
					text.inputEl.rows = 4;
					text.setPlaceholder("Templates\nDaily Notes")
						.setValue(this.plugin.settings.folderFilter)
						.onChange((value) => {
							this.plugin.settings.folderFilter = value;
							this.plugin.debouncedSave();
						});
				});

			new Setting(containerEl)
				.setName("Periodic auto-relink")
				.setHeading();

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
					.setClass("linkosaurus-input-number")
					.addText((text) => {
						text.inputEl.type = "number";
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

			new Setting(containerEl)
				.setName("Auto-link website URLs")
				.setDesc(
					"Convert URLs to Markdown links while typing or pasting. " +
					"Detects http(s)://... and bare domains (e.g. example.com)."
				)
				.addToggle((toggle) => {
					toggle
						.setValue(this.plugin.settings.urlAutolinkEnabled)
						.onChange(async (value) => {
							this.plugin.settings.urlAutolinkEnabled = value;
							await this.plugin.saveSettings();
							this.display();
						});
				});

			if (this.plugin.settings.urlAutolinkEnabled) {
				new Setting(containerEl)
					.setName("URL top-level domains")
					.setDesc(
						"TLDs to detect for bare domains (one per line, without leading dot). " +
						"Only affects bare domains — http(s):// URLs always link."
					)
					.setClass("linkosaurus-textarea-mono")
					.addTextArea((text) => {
						text.inputEl.rows = 6;
						text.setPlaceholder("de\ncom\norg")
							.setValue(this.plugin.settings.urlAutolinkTlds)
							.onChange((value) => {
								this.plugin.settings.urlAutolinkTlds = value;
								this.plugin.parseTlds();
								this.plugin.debouncedSave();
							});
					});
			}

			this.buildVaultDetails(containerEl);
		}
	}
}
