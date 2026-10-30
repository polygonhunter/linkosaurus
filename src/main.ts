import {
	Plugin,
	PluginSettingTab,
	App,
	Setting,
	Notice,
	EditorSuggest,
	MarkdownView,
	Modal,
	prepareFuzzySearch,
	renderMatches,
	setIcon,
	type Editor,
	type EditorChange,
	type EditorPosition,
	type EditorSuggestContext,
	type EditorSuggestTriggerInfo,
	type KeymapEventHandler,
	type SearchResult,
	type SettingDefinitionItem,
	type TFile,
} from "obsidian";
import * as obsidian from "obsidian";
import { EditorView, keymap } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import {
	MapMode,
	Prec,
	type Annotation,
	type ChangeDesc,
	type StateField,
} from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import {
	DEFAULT_LANGUAGES,
	LANGUAGE_PACKS,
	buildFoldTable,
	fold,
	foldVariants,
	foldWithMap,
	isFoldBoundary,
	parseLanguages,
	toFoldedIndex,
	toSrcIndex,
	type FoldTable,
} from "./fold";
import {
	formatEmailAsMarkdownLink,
	isEmailBoundary,
	matchEmailAtEnd,
	matchEmailInText,
} from "./email";
import {
	SETTINGS_VERSION,
	frontmatterSnapshot,
	isLinkableProperty,
	isPropertyValueField,
	linkFrontmatter,
	matchPropertySearchTrigger,
	migratePropertySettings,
	nextPropertyLinkAction,
	parsePropertyList,
	propertyLinkFromEntry,
	type PropertyMatcher,
} from "./properties";
import {
	hashStrings,
	isInFolders,
	isPluginOwnedNote,
	optsOutByFrontmatter,
	parseFolderList,
	passesFolderFilter,
} from "./destination";
import {
	affectsIndex,
	changedSettingKeys,
	clampRelinkInterval,
} from "./settings";
import {
	formatAliasLink,
	formatWikilink,
	sanitizeDisplay,
	sanitizeTarget,
	selfTargetName,
} from "./wikilink";
import {
	endsInHashtag,
	endsInUrl,
	frontmatterCloseLine,
	frontmatterEnd,
	isReferenceDefinition,
	isWordChar,
	skipAutolink,
	skipCalloutType,
	skipComment,
	skipDisplayMath,
	skipHashtag,
	skipFencedCode,
	skipInlineCode,
	skipInlineMath,
	skipHtml,
	skipReferenceDefinition,
	skipUrlLike,
} from "./skip";

interface AutoLinkSettings {
	keywordList: string;
	scanVaultLinks: boolean;
	caseInsensitive: boolean;
	foldDiacritics: boolean;
	foldLanguageMode: "all" | "selected";
	foldLanguages: string;
	scanFrontmatterAliases: boolean;
	blocklist: string;
	minKeywordLength: number;
	folderFilter: string;
	folderFilterMode: "include" | "exclude";
	neverLinkFolders: string;
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
	emailAutolinkEnabled: boolean;
	settingsVersion: number;
	propertyLinkEnabled: boolean;
	propertyLinkFields: string;
	propertyLinkOnEdit: boolean;
	propertyLinkPrefixMatch: boolean;
	urlAutolinkTlds: string;
}

const DEFAULT_SETTINGS: AutoLinkSettings = {
	keywordList: "",
	scanVaultLinks: true,
	caseInsensitive: true,
	foldDiacritics: true,
	foldLanguageMode: "all",
	foldLanguages: DEFAULT_LANGUAGES,
	scanFrontmatterAliases: true,
	blocklist: "",
	minKeywordLength: 0,
	folderFilter: "",
	folderFilterMode: "exclude",
	neverLinkFolders: "",
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
	emailAutolinkEnabled: true,
	settingsVersion: SETTINGS_VERSION,
	propertyLinkEnabled: true,
	propertyLinkFields: "",
	propertyLinkOnEdit: true,
	propertyLinkPrefixMatch: true,
	urlAutolinkTlds: "de\ncom\norg\nnet\nio\nshop\napp\ndev",
};

interface KeywordEntry {
	keyword: string;
	target: string;
}

// A keyword with everything matching needs precomputed: its folded spellings
// (canonical first) and its exact normalized form.
interface IndexedEntry extends KeywordEntry {
	folded: string[];
	exact: string;
	// normalize(target), precomputed for the self-link check.
	targetNorm: string;
	// True when the canonical fold preserves length, so fuzzy-match offsets
	// found on it are also valid positions in the raw keyword.
	foldedIdentity: boolean;
}

// One folded spelling of one entry. Ambiguous means another entry with a
// different target folds to the same string — "Zürich" and "Zurich" both
// reduce to "zurich" — so this spelling only matches on an exact hit.
interface FoldedKey {
	entry: IndexedEntry;
	key: string;
	ambiguous: boolean;
}

// Marks a transaction as its own undo step. Older Obsidian builds ship a
// CodeMirror whose history lives elsewhere; there the link simply joins the
// surrounding undo step, as it always did.
function historyIsolation(): Annotation<"full"> | undefined {
	const iso = isolateHistory as unknown as
		| { of?: (value: "full") => Annotation<"full"> }
		| undefined;
	try {
		return typeof iso?.of === "function" ? iso.of("full") : undefined;
	} catch {
		return undefined;
	}
}

// setCssStyles arrived in Obsidian 1.2, after this plugin's minAppVersion;
// older versions get the same styles set directly.
function setStyles(el: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
	if (typeof el.setCssStyles === "function") el.setCssStyles(styles);
	else Object.assign(el.style, styles);
}

// A note's frontmatter aliases. Only text and numbers count — an empty list
// item ("aliases:\n  - ") arrives as null and must not become the keyword
// "null".
function frontmatterAliases(fm: Record<string, unknown>): string[] {
	const raw: unknown = fm.aliases ?? fm.alias;
	const list: unknown[] = Array.isArray(raw)
		? raw
		: typeof raw === "string"
			? [raw]
			: [];
	const out: string[] = [];
	for (const alias of list) {
		if (typeof alias === "string" || typeof alias === "number") {
			out.push(String(alias));
		}
	}
	return out;
}

interface RelinkPlanItem {
	file: TFile;
	before: string;
	after: string;
	links: number;
}

interface RelinkPlan {
	items: RelinkPlanItem[];
	links: number;
	skippedOpen: number;
	skippedLarge: number;
	aborted: boolean;
}

interface VaultRunRecord {
	file: TFile;
	original: string;
	written: string;
}

interface PendingUndo {
	from: number;
	typedText: string;
	matchedKeywordNorm: string;
	timer: number;
	// The character typed after the keyword: " " while waiting for a longer
	// keyword ("Open" → "Open Source"), or "." ":" "?" while waiting to see
	// whether the word goes on ("Node.js", "github.com").
	trigger: string;
	// Where the link and its trigger end; a punctuation undo only applies
	// when typing continues right there.
	end: number;
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

export default class AutoLinkKeywordsPlugin extends Plugin {
	settings: AutoLinkSettings = { ...DEFAULT_SETTINGS };
	private entries: IndexedEntry[] = [];
	private lookupMap = new Map<string, string>();
	// Prefilters: a keyword can only match if its folded form ends (matcher A)
	// or starts (matcher B) with the same character as the text at that point.
	private byKey = new Map<string, FoldedKey[]>();
	// normalize(keyword) → entry; unique by construction (seenExact).
	private byExact = new Map<string, IndexedEntry>();
	// Every distinct folded key length, longest first.
	private keyLengths: number[] = [];
	// "open" when some keyword is "open …"; "open s" when one is "open s…".
	private growPrefixes = new Set<string>();
	private growNext = new Set<string>();
	private ambiguousKeys = new Set<string>();
	private foldTable: FoldTable = buildFoldTable({
		enabled: false,
		lowercase: true,
		allLanguages: true,
		languages: new Set<string>(),
	});
	private manualEntries: KeywordEntry[] = [];
	private manualLookup = new Map<string, string>();
	private vaultEntries: KeywordEntry[] = [];
	private blocklistSet = new Set<string>();
	private tldSet = new Set<string>();
	private scanTimer: number | null = null;
	private scanFirstRequest = 0;
	private sawResolved = false;
	// Per note: a hash of what it contributes to the keyword index.
	private keywordSignatures = new Map<string, string>();
	private saveTimer: number | null = null;
	private pendingUndo: PendingUndo | null = null;
	private lastAutolink: LastAutolink | null = null;
	// The most recent link typed into the editor, for taking it back with
	// Backspace.
	private revertable: {
		view: EditorView;
		time: number;
		from: number;
		insert: string;
		// What Backspace puts back: the typed word plus the trigger
		// character that followed it.
		restore: string;
		wordLength: number;
	} | null = null;
	// Places where the user took a link back; never re-linked there.
	private suppressed: { view: EditorView; from: number; to: number }[] = [];
	private deferredAutolinks: DeferredAutolink[] = [];
	private relinkTimer: number | null = null;
	private relinkDebounceTimer: number | null = null;
	private propertyLinkTimers = new Map<string, number>();
	private pendingPropertyLinks = new Map<string, TFile>();
	// Fields that already carry a suggestion popup. Weak so the entries go
	// away with the elements when a note closes.
	private propertySuggestFields = new WeakSet<HTMLElement>();
	// The popups themselves, so they can be closed when the plugin unloads.
	// Pruned as their fields leave the DOM.
	private propertySuggests = new Set<{
		field: HTMLElement;
		suggest: InputSuggestInstance;
	}>();
	// Timers that drop a file from propertyLinkWrites after the echo of our
	// own write has passed.
	private propertyEchoTimers = new Set<number>();
	// Last seen frontmatter per note, so a save that only changed the body
	// does not run property linking.
	private frontmatterSnapshots = new Map<string, string>();
	private propertyFocusTimer: number | null = null;
	// Files this plugin is currently writing to, so its own frontmatter edit
	// does not come back through the metadata cache as new work.
	private propertyLinkWrites = new Set<string>();
	private relinking = false;
	// The notes the last "all notes" command changed, with their text from
	// before and after, so it can be undone. Kept in memory only.
	private lastVaultRun: VaultRunRecord[] | null = null;
	// Notes the relink found nothing to do in, by modification time and the
	// index generation they were checked against.
	private relinkSkip = new Map<string, { mtime: number; generation: number }>();
	// Changes whenever anything that decides the bulk linker's output
	// changes: keywords, targets, matching options, URL/email/alias rules.
	private indexGeneration = 0;
	private indexSignature = "";
	// The settings the derived state was last built from.
	private appliedSettings: Record<string, unknown> | null = null;
	// Set in onunload: async work still in flight (vault relink, layout-ready
	// callback) checks it and stops instead of touching a dead plugin.
	unloaded = false;
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
					update.view,
					update.docChanged,
					update.selectionSet,
					update.changes
				)
			),
			// Backspace right after an auto-link takes it back. A keymap
			// rather than a keydown handler, so the synthesized Backspace of
			// mobile keyboards arrives here too.
			Prec.highest(
				keymap.of([
					{
						key: "Backspace",
						run: (view: EditorView) => this.revertAutolink(view),
					},
				])
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

				// The keyword becomes one line of the keyword list, where a
				// line break, "=" (the mapping separator) or a leading "#" (a
				// comment) would turn it into something else.
				if (/[\n=]/.test(text) || text.trim().startsWith("#")) {
					new Notice(
						"Linkosaurus: a keyword cannot contain line breaks or “=”, or start with “#”."
					);
					return;
				}

				const cursor = editor.getCursor("from");
				const lineText = editor.getLine(cursor.line);
				const before = lineText.substring(0, cursor.ch);
				if (this.isInsideWikilink(before)) return;

				const link = formatWikilink(text, text);
				if (!link) return;
				editor.replaceSelection(link);

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
			editorCallback: (editor, ctx) => {
				const content = editor.getValue();
				if (content.length > 100000) {
					new Notice(
						"Note too large for auto-linking (max 100k characters)."
					);
					return;
				}
				// The note behind this editor — in a hover preview or on a
				// canvas that is not the active one.
				const file = ctx.file ?? this.app.workspace.getActiveFile();
				if (!this.allowsLinksIn(file)) {
					new Notice(
						"Linkosaurus: this note is excluded from linking (folder or linkosaurus: false)."
					);
					return;
				}
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
				// Only the changed stretch of each line is replaced, so the
				// cursor, scroll position and folds stay where they were.
				const changes = AutoLinkKeywordsPlugin.lineEdits(content, replaced);
				if (changes) {
					editor.transaction({ changes });
				} else {
					const lastLine = editor.lastLine();
					const lastCh = editor.getLine(lastLine).length;
					editor.replaceRange(
						replaced,
						{ line: 0, ch: 0 },
						{ line: lastLine, ch: lastCh }
					);
				}
				new Notice("Keywords auto-linked.");
			},
		});

		this.addCommand({
			id: "relink-all-notes",
			name: "Auto-link keywords in all notes",
			callback: () => {
				void this.runVaultCommand();
			},
		});

		this.addCommand({
			id: "undo-relink-all-notes",
			name: "Undo last vault-wide link",
			checkCallback: (checking: boolean) => {
				if (!this.lastVaultRun) return false;
				if (!checking) void this.undoVaultRun();
				return true;
			},
		});

		this.addCommand({
			id: "link-properties",
			name: "Link property values in current note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.linkProperties(file, true);
				return true;
			},
		});

		this.addSettingTab(new AutoLinkSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) return;
			// The first index is built right away; only later rescans are
			// debounced.
			this.scheduleScan(true);
			this.startPeriodicRelink();
			// Registered only once the vault has loaded: Obsidian fires a
			// "create" for every existing file while it starts up, and each
			// of those would otherwise queue a rescan and a vault-wide
			// relink.
			this.registerEvent(
				this.app.vault.on("create", () => {
					this.scheduleScan();
					this.scheduleRelinkDebounced();
				})
			);
			this.registerEvent(
				this.app.vault.on("delete", (file) => {
					this.forgetPath(file.path);
					this.scheduleScan();
				})
			);
			this.registerEvent(
				this.app.vault.on("rename", (_file, oldPath) => {
					this.forgetPath(oldPath);
					this.scheduleScan();
					this.scheduleRelinkDebounced();
				})
			);
		});

		// "resolved" fires after every change once the cache is warm; only
		// the first one — the cache finishing its initial pass — matters.
		this.registerEvent(
			this.app.metadataCache.on("resolved", () => {
				if (this.sawResolved) return;
				this.sawResolved = true;
				this.scheduleScan();
			})
		);
		// Every autosave while typing reports a change. The index only
		// depends on a note's name, aliases and outgoing links, so a rescan
		// runs only when one of those changed.
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (this.keywordSignatureChanged(file)) this.scheduleScan();
				this.schedulePropertyLink(file);
			})
		);
		// Entering a property field is where the popup gets attached — the
		// fields are created and destroyed as notes open, so there is nothing
		// stable to hook at load time.
		this.registerDomEvent(document, "focusin", (evt: FocusEvent) => {
			this.attachPropertySuggest(evt.target);
		});
		// Leaving the property panel is the moment a value is finished, and
		// switching notes is the last chance to catch one.
		this.registerDomEvent(document, "focusout", () => {
			if (this.propertyFocusTimer !== null) {
				window.clearTimeout(this.propertyFocusTimer);
			}
			// Tabbing between fields lands here too; the delay lets focus
			// settle before deciding whether the panel was really left.
			this.propertyFocusTimer = window.setTimeout(() => {
				this.propertyFocusTimer = null;
				this.flushPropertyLinks();
			}, 150);
		});
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.flushPropertyLinks()
			)
		);
		// The baseline for telling property edits from body edits.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file && file.extension === "md") this.rememberFrontmatter(file);
			})
		);
	}

	onunload() {
		this.unloaded = true;
		if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
		// A settings edit still waiting for its debounce must not be lost.
		this.flushPendingSave();
		this.stopPeriodicRelink();
		if (this.relinkDebounceTimer !== null) window.clearTimeout(this.relinkDebounceTimer);
		for (const timer of this.propertyLinkTimers.values()) {
			window.clearTimeout(timer);
		}
		this.propertyLinkTimers.clear();
		this.pendingPropertyLinks.clear();
		if (this.propertyFocusTimer !== null) {
			window.clearTimeout(this.propertyFocusTimer);
		}
		for (const timer of this.propertyEchoTimers) window.clearTimeout(timer);
		this.propertyEchoTimers.clear();
		this.propertyLinkWrites.clear();
		for (const { suggest } of this.propertySuggests) {
			try {
				suggest.close();
			} catch {
				// The field may already be gone.
			}
		}
		this.propertySuggests.clear();
		this.aliasSuggest?.close();
		this.aliasSuggest = null;
		this.lastAutolink = null;
		// Drop the references to editor views so closed panes can go.
		this.revertable = null;
		this.suppressed = [];
		this.clearPendingUndo();
		this.cancelDeferredAutolinks();
	}

	// Writes a settings change that is still waiting in debouncedSave right
	// away. Used when the plugin unloads and when the settings tab closes.
	flushPendingSave() {
		if (this.saveTimer === null) return;
		window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		void this.saveSettings();
	}

	// The edits that turn `before` into `after`, one per changed line and
	// limited to the part of the line that differs. Linking never adds or
	// removes a line break; null when the line counts differ anyway.
	static lineEdits(before: string, after: string): EditorChange[] | null {
		const oldLines = before.split("\n");
		const newLines = after.split("\n");
		if (oldLines.length !== newLines.length) return null;
		const changes: EditorChange[] = [];
		oldLines.forEach((oldLine, line) => {
			const newLine = newLines[line]!;
			if (oldLine === newLine) return;
			const max = Math.min(oldLine.length, newLine.length);
			let head = 0;
			while (head < max && oldLine.charAt(head) === newLine.charAt(head)) head++;
			let tail = 0;
			while (
				tail < max - head &&
				oldLine.charAt(oldLine.length - 1 - tail) ===
					newLine.charAt(newLine.length - 1 - tail)
			)
				tail++;
			changes.push({
				from: { line, ch: head },
				to: { line, ch: oldLine.length - tail },
				text: newLine.substring(head, newLine.length - tail),
			});
		});
		return changes;
	}

	private normalize(text: string): string {
		return this.settings.caseInsensitive ? text.toLowerCase() : text;
	}

	// The matching form of a string: normalize() plus, when cross-language
	// matching is on, accents and special letters folded away.
	foldKey(text: string): string {
		return fold(text, this.foldTable);
	}

	// Must run before anything that folds — parseBlocklist and
	// parseManualKeywords both bake the current table into their output.
	// foldVariants per keyword, valid for the current fold table. A rescan
	// rebuilds the index from mostly the same keywords, so this saves
	// re-folding every note name each time.
	private foldVariantCache = new Map<string, string[]>();

	private foldVariantsCached(keyword: string): string[] {
		let variants = this.foldVariantCache.get(keyword);
		if (variants === undefined) {
			// Renames leave old names behind; start over rather than grow
			// without bound.
			if (this.foldVariantCache.size > 4 * this.entries.length + 5000) {
				this.foldVariantCache.clear();
			}
			variants = foldVariants(keyword, this.foldTable);
			this.foldVariantCache.set(keyword, variants);
		}
		return variants;
	}

	rebuildFoldTable() {
		this.foldVariantCache.clear();
		this.foldTable = buildFoldTable({
			enabled: this.settings.foldDiacritics,
			lowercase: this.settings.caseInsensitive,
			allLanguages: this.settings.foldLanguageMode === "all",
			languages: parseLanguages(this.settings.foldLanguages),
		});
	}

	private handleEditorUpdate(
		view: EditorView,
		docChanged: boolean,
		selectionSet: boolean,
		changes?: ChangeDesc
	) {
		if (docChanged && this.revertable) this.revertable = null;
		if (docChanged && changes && this.suppressed.length > 0) {
			this.suppressed = this.suppressed.filter((sp) => {
				if (sp.view !== view) return true;
				const from = changes.mapPos(sp.from, 1, MapMode.TrackDel);
				const to = changes.mapPos(sp.to, -1, MapMode.TrackDel);
				if (from === null || to === null || to <= from) return false;
				sp.from = from;
				sp.to = to;
				return true;
			});
		}
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
				// Changes describe one editor's document only.
				if (d.view !== view) continue;
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
		// With several cursors the default input goes to all of them; a
		// dispatch of ours would only serve the main one and collapse the rest.
		if (view.state.selection.ranges.length > 1) return false;

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
			if (/^\s+$/.test(text)) {
				// After "Berlin." a space ends the sentence; only the wait
				// for a longer multi-word keyword goes on across it.
				if (this.pendingUndo.trigger !== " ") this.clearPendingUndo();
				return false;
			}
			// A keyword only grows into a longer one across word characters
			// (e.g. "Open" → "Open Source"). Any non-word character — sentence
			// punctuation or a separator like "-" in "T-Rex - Facebook" — ends
			// the current keyword, so keep the link that was already created
			// instead of undoing it.
			if (!isWordChar(text)) {
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

		// A line break arriving as text input (not as the Enter key, which
		// handleEnterKey covers) is a plain "\n" either way — no list
		// continuation is lost by inserting it ourselves, and the default
		// input would land at a position our link just shifted.
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
		if (!sel.empty || view.state.selection.ranges.length > 1) return false;

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

		// Link only the word and leave the line break to Obsidian: its Enter
		// command is what continues lists, checkboxes and quotes and keeps
		// the indentation. Inserting "\n" here would bypass all of that.
		this.tryAutolinkBeforeCursor(view, sel.head, "", false);
		return false;
	}

	// Returns false when the user took back a link at exactly this place
	// before; the text then stays as typed. `explicit` (a pick from the
	// popup) always links.
	private dispatchAutolink(
		view: EditorView,
		absStart: number,
		replaceEnd: number,
		insert: string,
		preserveCursor: boolean,
		opts: {
			// A pick from the popup: always links.
			explicit?: boolean;
			// Where the matched word ends (before any trigger character).
			matchEnd?: number;
			// The trigger character(s) appended after the link.
			trailing?: string;
		} = {}
	): boolean {
		const matchEnd = opts.matchEnd ?? replaceEnd;
		if (!opts.explicit && this.isSuppressed(view, absStart, matchEnd))
			return false;
		const oldText = view.state.doc.sliceString(absStart, replaceEnd);
		const word = view.state.doc.sliceString(absStart, matchEnd);
		view.dispatch({
			changes: { from: absStart, to: replaceEnd, insert },
			...(preserveCursor
				? {}
				: { selection: { anchor: absStart + insert.length } }),
			// Its own undo step: Ctrl+Z takes back the link, not the whole
			// sentence typed before it.
			annotations: historyIsolation(),
			userEvent: "input.autolink",
		});
		// Recorded after dispatching: the update listener clears any previous
		// record on doc changes, then we install the fresh one.
		const now = Date.now();
		this.lastAutolink = {
			view,
			time: now,
			from: absStart,
			to: replaceEnd,
			text: oldText,
		};
		this.revertable = preserveCursor
			? null
			: {
					view,
					time: now,
					from: absStart,
					insert,
					restore: word + (opts.trailing ?? ""),
					wordLength: word.length,
				};
		return true;
	}

	private isSuppressed(view: EditorView, from: number, to: number): boolean {
		return this.suppressed.some(
			(sp) => sp.view === view && sp.from === from && sp.to === to
		);
	}

	// Backspace within a few seconds of an auto-link, with the cursor still
	// right behind it, restores the typed text and remembers the place so
	// the next space does not link it again.
	private revertAutolink(view: EditorView): boolean {
		const rec = this.revertable;
		if (!rec || rec.view !== view) return false;
		if (Date.now() - rec.time > 3000) {
			this.revertable = null;
			return false;
		}
		const sel = view.state.selection.main;
		const end = rec.from + rec.insert.length;
		if (!sel.empty || sel.head !== end) return false;
		if (view.state.selection.ranges.length > 1) return false;
		if (view.state.doc.sliceString(rec.from, end) !== rec.insert) return false;

		// The trigger character typed after the word (space, punctuation)
		// stays; only the link turns back into the typed word.
		const restore = rec.restore;
		this.revertable = null;
		this.clearPendingUndo();
		view.dispatch({
			changes: { from: rec.from, to: end, insert: restore },
			selection: { anchor: rec.from + restore.length },
			annotations: historyIsolation(),
			userEvent: "delete.autolink",
		});
		if (this.suppressed.length >= 32) this.suppressed.shift();
		this.suppressed.push({
			view,
			from: rec.from,
			to: rec.from + rec.wordLength,
		});
		return true;
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
		if (!this.activeFileAllowsLinks(view)) return false;
		if (this.isInsideLink(textBefore)) return false;
		// A link reference definition keeps its bare destination.
		if (isReferenceDefinition(textBefore)) return false;
		// An active note search owns its query: spaces and punctuation are
		// part of what the user is filtering for, so the auto-linker must not
		// grab words out of it (it would inject [[..]] into the query and
		// kill the popup). The search resolves via the popup instead.
		if (
			this.settings.noteSearchEnabled &&
			this.matchNoteSearchPrefix(textBefore)
		)
			return false;

		// Addresses link only once the word is over (space, Enter): "." ":"
		// and "?" also occur inside them, and "https://www.github." is not
		// an address yet. Closing punctuation typed before the space stays
		// outside the link.
		const wordDone = trailing === "" || /\s$/.test(trailing);
		const tail = wordDone ? /[.,;:!?)]*$/.exec(textBefore)![0] : "";
		const core = textBefore.substring(0, textBefore.length - tail.length);

		// Before the URL matcher: an address ends in a domain, so whichever
		// runs first wins the overlap.
		if (wordDone && this.settings.emailAutolinkEnabled) {
			const emailMatch = matchEmailAtEnd(core);
			if (emailMatch) {
				const absStart = line.from + emailMatch.start;
				const insert =
					formatEmailAsMarkdownLink(emailMatch.address) +
					core.substring(emailMatch.start + emailMatch.address.length) +
					tail +
					trailing;
				return this.dispatchAutolink(
					view,
					absStart,
					replaceEnd,
					insert,
					preserveCursor,
					{ matchEnd: pos, trailing }
				);
			}
		}

		const urlMatch = wordDone ? this.matchUrlAtEnd(core) : null;
		if (urlMatch) {
			const absStart = line.from + urlMatch.start;
			const insert =
				this.formatUrlAsMarkdownLink(urlMatch.url) + tail + trailing;
			return this.dispatchAutolink(
				view,
				absStart,
				replaceEnd,
				insert,
				preserveCursor,
				{ matchEnd: pos, trailing }
			);
		}

		// Part of an address that is not linked as one: no keyword inside it.
		if (endsInUrl(textBefore)) return false;

		const alias = this.matchAlias(textBefore);
		if (alias) {
			const file = this.fileOfView(view);
			if (file && this.normalize(alias.target) === this.normalize(file.basename))
				return false;
			const absStart = line.from + alias.start;
			const link = formatAliasLink(alias.target, alias.displayText);
			if (!link) return false;
			const insert = link + trailing;
			return this.dispatchAutolink(
				view,
				absStart,
				replaceEnd,
				insert,
				preserveCursor,
				{ matchEnd: pos, trailing }
			);
		}

		const direct = this.matchKeyword(textBefore);
		if (direct) {
			const file = this.fileOfView(view);
			if (file && this.normalize(direct.target) === this.normalize(file.basename))
				return false;
			const absStart = line.from + direct.start;
			const link = formatWikilink(direct.keyword, direct.target);
			if (!link) return false;
			const insert = link + trailing;
			if (
				!this.dispatchAutolink(
					view,
					absStart,
					replaceEnd,
					insert,
					preserveCursor,
					{ matchEnd: pos, trailing }
				)
			)
				return false;

			const kwNorm = this.foldKey(direct.keyword);
			// Every folded spelling counts: with the Scandinavian pack on,
			// "Soeren Kierkegaard" must still be seen as a longer match
			// after [[Søren]] has fired.
			const waitsForLonger =
				setupPendingUndo && this.growPrefixes.has(kwNorm);
			// "Node." may go on as "Node.js": a letter or digit typed right
			// after the "." takes the link back.
			const waitsForWord =
				!preserveCursor && trailing.length === 1 && ".:?".includes(trailing);
			if (waitsForLonger || waitsForWord) {
				this.clearPendingUndo();
				this.pendingUndo = {
					from: absStart,
					typedText: direct.typedText,
					matchedKeywordNorm: kwNorm,
					timer: window.setTimeout(
						() => (this.pendingUndo = null),
						5000
					),
					trigger: waitsForLonger ? " " : trailing,
					end: absStart + insert.length,
				};
			}

			return true;
		}

		return false;
	}

	// Whether replaceKeywordsInText can change anything at all.
	private hasBulkWork(): boolean {
		return (
			this.entries.length > 0 ||
			this.settings.urlAutolinkEnabled ||
			this.settings.emailAutolinkEnabled
		);
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

		if (!this.hasBulkWork()) return false;
		if (text.length > 10000) return false;
		if (!this.activeFileAllowsLinks(view)) return false;

		const state = view.state;
		const line = state.doc.lineAt(from);
		const colOffset = from - line.from;
		if (this.isInCodeContext(view, from, line.text, colOffset))
			return false;

		const textBefore = line.text.substring(0, colOffset);
		if (this.isInsideLink(textBefore)) return false;

		const charBefore =
			from > 0 ? state.doc.sliceString(from - 1, from) : "";
		const charAfter =
			to < state.doc.length
				? state.doc.sliceString(to, to + 1)
				: "";

		const file = this.fileOfView(view);
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
		// Rich text is Obsidian's to convert to Markdown; taking the plain
		// text instead would drop its headings, lists and links.
		if (Array.from(event.clipboardData?.types ?? []).includes("text/html"))
			return false;
		// URLs and email addresses link without any keyword.
		if (!this.hasBulkWork()) return false;
		if (!this.activeFileAllowsLinks(view)) return false;
		if (view.state.selection.ranges.length > 1) return false;
		// A URL pasted over selected text is Obsidian's own [selection](url).
		if (
			!view.state.selection.main.empty &&
			/^\s*[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+\s*$/.test(text)
		)
			return false;

		const state = view.state;
		const { from, to } = state.selection.main;
		const line = state.doc.lineAt(from);
		const colOffset = from - line.from;

		if (this.isInCodeContext(view, from, line.text, colOffset)) return false;
		const textBefore = line.text.substring(0, colOffset);
		if (this.isInsideLink(textBefore)) return false;

		const file = this.fileOfView(view);
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
		skipKeyword?: string,
		// Counts the links created, for the vault-wide preview.
		stats?: { links: number }
	): string {
		const result: string[] = [];
		// i stays a raw index throughout; the fold map bridges to folded space
		// only where keywords are compared.
		const folded = foldWithMap(text, this.foldTable);
		const foldedText = folded.folded;
		const skipNorm = skipKeyword
			? this.normalize(skipKeyword)
			: undefined;
		let i = 0;

		const fmEnd = frontmatterEnd(text);
		if (fmEnd > 0) {
			result.push(text.substring(0, fmEnd));
			i = fmEnd;
		}

		// Regions that are not prose: pushed through untouched.
		const skipRegion = (end: number): boolean => {
			if (end <= i) return false;
			result.push(text.substring(i, end));
			i = end;
			return true;
		};

		while (i < text.length) {
			const c0 = text.charAt(i);

			// Fences open only at the start of a line; elsewhere a run of
			// backticks is inline code, handled below.
			if (
				(c0 === "`" || c0 === "~") &&
				skipRegion(skipFencedCode(text, i, charBefore))
			)
				continue;

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

			if (c0 === "`") {
				// Paired with a closer of the same length in the same
				// paragraph; a stray backtick is just a character and
				// scanning goes on after it.
				let end = skipInlineCode(text, i);
				if (end === -1) {
					end = i;
					while (end < text.length && text.charAt(end) === "`") end++;
				}
				skipRegion(end);
				continue;
			}

			const ch = text.charAt(i);
			if (
				ch === "<" &&
				(skipRegion(skipAutolink(text, i)) ||
					skipRegion(skipHtml(text, i, charBefore)))
			)
				continue;
			if (ch === "%" && skipRegion(skipComment(text, i))) continue;
			if (ch === "$") {
				if (skipRegion(skipDisplayMath(text, i))) continue;
				if (skipRegion(skipInlineMath(text, i))) continue;
			}
			if (
				ch === "[" &&
				(skipRegion(skipReferenceDefinition(text, i, charBefore)) ||
					skipRegion(skipCalloutType(text, i)))
			)
				continue;
			if (
				ch === "#" &&
				skipRegion(
					skipHashtag(text, i, i === 0 ? charBefore : text.charAt(i - 1))
				)
			)
				continue;

			// Read from the raw text: this only tests for the ASCII scheme
			// prefix, and folded offsets do not line up with i.
			const urlPrefix = text.substring(i, i + 8).toLowerCase();
			if (
				urlPrefix.startsWith("http://") ||
				urlPrefix.startsWith("https://")
			) {
				const urlMatch = this.matchUrlInText(text, i, "");
				if (urlMatch) {
					if (this.settings.urlAutolinkEnabled && stats) stats.links++;
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
				if (stats) stats.links++;
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
			const atStartBoundary = !isWordChar(prevChar);

			if (atStartBoundary && this.settings.emailAutolinkEnabled) {
				const email = matchEmailInText(text, i, prevChar);
				if (email) {
					if (stats) stats.links++;
					result.push(formatEmailAsMarkdownLink(email.address));
					i = email.end;
					continue;
				}
			}

			if (atStartBoundary) {
				const bareUrl = this.matchUrlInText(text, i, prevChar);
				if (bareUrl) {
					if (stats) stats.links++;
					result.push(this.formatUrlAsMarkdownLink(bareUrl.url));
					i = bareUrl.end;
					continue;
				}
			}

			// An address that was not linked as one (URL linking off, or a
			// top-level domain not on the list) stays whole.
			if (atStartBoundary && skipRegion(skipUrlLike(text, i))) continue;

			// "[^Berlin]" is a footnote label and "^Berlin" a block id.
			if (atStartBoundary && prevChar !== "^") {
				let matched = false;
				// i is a raw character boundary, so the folded index it maps
				// to is a fold boundary by construction — only the end of a
				// candidate match needs checking.
				const foldedStart = toFoldedIndex(folded, i);
				// Longest first: one map lookup per distinct key length
				// instead of comparing every keyword with this first letter.
				search: for (const len of this.keyLengths) {
					const foldedEnd = foldedStart + len;
					if (foldedEnd > foldedText.length) continue;
					const candidates = this.byKey.get(
						foldedText.substring(foldedStart, foldedEnd)
					);
					if (!candidates) continue;
					if (!isFoldBoundary(folded, foldedEnd)) continue;
					for (const { entry, ambiguous } of candidates) {
					if (skipNorm && entry.targetNorm === skipNorm) continue;

					const endPos = toSrcIndex(folded, foldedEnd);
					if (
						ambiguous &&
						this.normalize(text.substring(i, endPos)) !==
							entry.exact
					)
						continue;

					const nextChar =
						endPos < text.length
							? text.charAt(endPos)
							: charAfter;
					if (isWordChar(nextChar)) continue;

					const link = formatWikilink(entry.keyword, entry.target);
					if (!link) continue;
					if (stats) stats.links++;
					result.push(link);
					i = endPos;
					matched = true;
					break search;
					}
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

		if (pending.trigger !== " ") {
			// "Node." + "j": the word goes on, so the link was premature —
			// but only when typing continues right behind the ".".
			this.clearPendingUndo();
			if (from !== pending.end) return false;
			const restore = pending.typedText + pending.trigger + text;
			view.dispatch({
				changes: { from: pending.from, to: from, insert: restore },
				selection: { anchor: pending.from + restore.length },
			});
			return true;
		}

		const firstChar = text.charAt(0);
		const firstCharNorm = this.foldKey(firstChar);
		const prefix =
			pending.matchedKeywordNorm + " " + firstCharNorm;
		// O(1) through the sets built with the index. A character that
		// folds to several (ß → ss) is checked on its first one, then
		// confirmed by a scan; one that folds away only needs the space.
		let couldGrow: boolean;
		if (firstCharNorm.length === 0) {
			couldGrow = this.growPrefixes.has(pending.matchedKeywordNorm);
		} else if (firstCharNorm.length === 1) {
			couldGrow = this.growNext.has(prefix);
		} else {
			couldGrow =
				this.growNext.has(prefix.substring(0, prefix.length - firstCharNorm.length + 1)) &&
				this.entries.some((e) => e.folded.some((v) => v.startsWith(prefix)));
		}

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
		if (this.isInsideLink(line.text.substring(0, colOffset))) return;
		if (!this.activeFileAllowsLinks(d.view)) return;

		const file = this.fileOfView(d.view);
		const selfName = file?.basename ?? "";
		let regionEnd = end;
		let finalText = d.text;

		// Pass 1: transform the committed range itself, linking every
		// keyword/URL inside it (dictated sentences, swiped words).
		if (this.hasBulkWork()) {
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
					// The committed text is already in the document, so the
					// links get their own undo step, as when typing.
					annotations: historyIsolation(),
					userEvent: "input.autolink",
				});
				const now = Date.now();
				this.lastAutolink = {
					view: d.view,
					time: now,
					from: d.from,
					to: end,
					text: d.text,
				};
				// Backspace right after a swiped or dictated word takes the
				// links back, as it does for a typed one.
				const word = d.text.replace(/[\s\p{P}]+$/u, "");
				this.revertable =
					cursorAtEnd && word
						? {
								view: d.view,
								time: now,
								from: d.from,
								insert: replaced,
								restore: d.text,
								wordLength: word.length,
							}
						: null;
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
		const minutes = clampRelinkInterval(
			this.settings.periodicRelinkIntervalMinutes
		);
		const ms = minutes * 60 * 1000;
		// registerInterval clears it on unload even if stopPeriodicRelink is
		// never reached.
		this.relinkTimer = this.registerInterval(
			window.setInterval(() => {
				void this.relinkVault(false);
			}, ms)
		);
	}

	stopPeriodicRelink() {
		if (this.relinkTimer !== null) {
			window.clearInterval(this.relinkTimer);
			this.relinkTimer = null;
		}
	}

	private scheduleRelinkDebounced() {
		if (this.unloaded || !this.settings.periodicRelink) return;
		if (this.relinkDebounceTimer !== null) window.clearTimeout(this.relinkDebounceTimer);
		this.relinkDebounceTimer = window.setTimeout(() => {
			this.relinkDebounceTimer = null;
			void this.relinkVault(false);
		}, 5000);
	}

	// Paths of every note currently shown in a pane. Asked fresh for each
	// write, since a note may be opened while the relink is running.
	private openFilePaths(): Set<string> {
		const open = new Set<string>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			const viewState = leaf.view?.getState();
			if (viewState?.file) open.add(viewState.file as string);
		});
		return open;
	}

	// Whether Linkosaurus may change this note at all: not in a "never
	// link" folder, not opted out by its frontmatter, not a drawing or
	// board owned by another plugin. Applies to typing, pasting, the
	// commands and property linking alike.
	allowsLinksIn(file: TFile | null): boolean {
		if (!file) return true;
		if (isInFolders(file.path, this.neverFolders())) return false;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (optsOutByFrontmatter(fm)) return false;
		if (isPluginOwnedNote(file.path, fm)) return false;
		return true;
	}

	// Whether the vault-wide linkers may write into this note: the same
	// opt-outs as typing. The scan folder filter only decides which notes
	// become keywords; "Never link inside these folders" decides where
	// links are written.
	isLinkableDestination(file: TFile): boolean {
		if (file.extension !== "md") return false;
		return this.allowsLinksIn(file);
	}

	private neverFolderCache: { raw: string; folders: string[] } | null = null;

	private neverFolders(): string[] {
		const raw = this.settings.neverLinkFolders;
		if (this.neverFolderCache?.raw !== raw) {
			this.neverFolderCache = { raw, folders: parseFolderList(raw) };
		}
		return this.neverFolderCache.folders;
	}

	// The note behind an editor. Hover previews, embeds and canvas cards
	// edit a different note than the active one; Obsidian's editorInfoField
	// names it. Without that field the active file is the best guess.
	private fileOfView(view: EditorView): TFile | null {
		const field = (obsidian as unknown as Record<string, unknown>)
			.editorInfoField as StateField<{ file?: TFile | null }> | undefined;
		if (field) {
			try {
				const info = view.state.field(field, false);
				if (info) return info.file ?? null;
			} catch {
				// Not an Obsidian editor: fall back below.
			}
		}
		return this.app.workspace.getActiveFile();
	}

	private activeFileAllowsLinks(view: EditorView): boolean {
		return this.allowsLinksIn(this.fileOfView(view));
	}

	// Writes the linked version of a note. vault.process (Obsidian 1.1) reads
	// and writes in one step, so an edit landing between our read and our
	// write is linked as well instead of being overwritten; older versions
	// fall back to read + modify. Returns what was there and what was
	// written, or null when nothing changed.
	private async writeLinked(
		file: TFile,
		expected?: { before: string; after: string }
	): Promise<{ original: string; written: string } | null> {
		const vault = this.app.vault as unknown as {
			process?: (
				file: TFile,
				fn: (data: string) => string
			) => Promise<string>;
		};
		const link = (data: string) => {
			// The preview already computed this exact text.
			if (expected && data === expected.before) return expected.after;
			return data.length > 100000
				? data
				: this.replaceKeywordsInText(data, "", "", file.basename);
		};
		let original = "";
		let written = "";
		if (typeof vault.process === "function") {
			await vault.process.call(this.app.vault, file, (data: string) => {
				original = data;
				written = link(data);
				return written;
			});
		} else {
			original = await this.app.vault.read(file);
			written = link(original);
			if (written !== original) await this.app.vault.modify(file, written);
		}
		return written === original ? null : { original, written };
	}

	// Walks the vault and works out which notes the bulk linker would
	// change, without writing anything. Gives the UI a frame every 50
	// notes and stops when the plugin unloads.
	private async planRelink(
		progress?: (done: number, total: number) => void
	): Promise<RelinkPlan> {
		const files = this.app.vault.getMarkdownFiles();
		const plan: RelinkPlan = {
			items: [],
			links: 0,
			skippedOpen: 0,
			skippedLarge: 0,
			aborted: false,
		};
		let open = this.openFilePaths();
		const activePath = this.app.workspace.getActiveFile()?.path;
		let visited = 0;

		for (const file of files) {
			if (this.unloaded) {
				plan.aborted = true;
				break;
			}
			if (++visited % 50 === 0) {
				progress?.(visited, files.length);
				await new Promise<void>((r) => window.setTimeout(r, 0));
				if (this.unloaded) {
					plan.aborted = true;
					break;
				}
				open = this.openFilePaths();
			}
			if (!this.isLinkableDestination(file)) continue;

			// Unchanged note, unchanged index: it produced nothing last
			// time and will produce nothing now.
			const generation = this.indexGeneration;
			const seen = this.relinkSkip.get(file.path);
			if (
				seen &&
				seen.mtime === file.stat.mtime &&
				seen.generation === generation
			)
				continue;

			// Open notes are skipped to avoid cursor jumps.
			if (open.has(file.path) || file.path === activePath) {
				plan.skippedOpen++;
				continue;
			}

			const before = await this.app.vault.cachedRead(file);
			if (before.length > 100000) {
				plan.skippedLarge++;
				continue;
			}
			const stats = { links: 0 };
			const after = this.replaceKeywordsInText(
				before,
				"",
				"",
				file.basename,
				stats
			);
			if (after === before) {
				this.relinkSkip.set(file.path, {
					mtime: file.stat.mtime,
					generation,
				});
				continue;
			}
			plan.items.push({ file, before, after, links: stats.links });
			plan.links += stats.links;
		}
		progress?.(files.length, files.length);
		return plan;
	}

	// Writes a plan. Each note is re-checked for being open right before
	// its write. Returns the changes, for undo.
	private async applyRelink(
		plan: RelinkPlan,
		progress?: (done: number, total: number) => void
	): Promise<VaultRunRecord[]> {
		const records: VaultRunRecord[] = [];
		let done = 0;
		for (const item of plan.items) {
			if (this.unloaded) break;
			if (++done % 20 === 0) {
				progress?.(done, plan.items.length);
				await new Promise<void>((r) => window.setTimeout(r, 0));
			}
			// The note may have been opened in the meantime.
			if (this.openFilePaths().has(item.file.path)) continue;
			try {
				const result = await this.writeLinked(item.file, item);
				if (result) records.push({ file: item.file, ...result });
				// Only a successful write marks the note as done; a failed
				// one (locked file, sync conflict) is retried next time.
				this.relinkSkip.set(item.file.path, {
					mtime: item.file.stat.mtime,
					generation: this.indexGeneration,
				});
			} catch (error) {
				this.relinkSkip.delete(item.file.path);
				console.error(`Linkosaurus: could not link ${item.file.path}`, error);
			}
		}
		return records;
	}

	// The periodic and event-driven relink: no preview, no undo record.
	private async relinkVault(showNotice: boolean) {
		if (this.relinking || this.unloaded) return;
		if (this.entries.length === 0) return;
		this.relinking = true;
		try {
			const plan = await this.planRelink();
			const records = await this.applyRelink(plan);
			if (showNotice && !this.unloaded) {
				new Notice(
					records.length > 0
						? `Linkosaurus: Auto-linked keywords in ${records.length} note${records.length === 1 ? "" : "s"}.`
						: "Linkosaurus: No keywords found to link."
				);
			}
		} catch (error) {
			// Runs from a timer: a note deleted mid-scan must not surface as
			// an unhandled rejection. The next run starts over.
			console.error("Linkosaurus: periodic relink failed", error);
		} finally {
			this.relinking = false;
		}
	}

	// "Auto-link keywords in all notes": a dry run first, shown in a
	// confirmation dialog, then the write with progress — and the original
	// text kept so the run can be undone.
	private async runVaultCommand() {
		if (this.relinking) {
			new Notice("Linkosaurus: linking all notes is already running.");
			return;
		}
		if (!this.hasBulkWork()) {
			new Notice(
				"Linkosaurus: there are no keywords to link yet. Add some in the settings or turn on vault link detection."
			);
			return;
		}
		this.relinking = true;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			this.relinking = false;
		};
		try {
			const checking = new Notice("Linkosaurus: checking notes…", 0);
			let plan: RelinkPlan;
			try {
				plan = await this.planRelink((done, total) =>
					checking.setMessage(`Linkosaurus: checking notes ${done}/${total}…`)
				);
			} finally {
				checking.hide();
			}
			if (plan.aborted || this.unloaded) {
				release();
				return;
			}
			if (plan.items.length === 0) {
				new Notice(
					"Linkosaurus: no keywords found to link." +
						VaultRunModal.skippedText(plan)
				);
				release();
				return;
			}
			new VaultRunModal(this.app, plan, {
				onConfirm: () => {
					void this.confirmVaultRun(plan).finally(release);
				},
				onCancel: release,
			}).open();
		} catch (error) {
			release();
			// Called without awaiting: an error rethrown here would only be
			// an unhandled rejection.
			console.error("Linkosaurus: could not check the notes", error);
			new Notice("Linkosaurus: could not check the notes.");
		}
	}

	private async confirmVaultRun(plan: RelinkPlan) {
		const total = plan.items.length;
		const notice = new Notice(`Linkosaurus: linking 0/${total} notes…`, 0);
		let records: VaultRunRecord[];
		try {
			records = await this.applyRelink(plan, (done) =>
				notice.setMessage(`Linkosaurus: linking ${done}/${total} notes…`)
			);
		} finally {
			notice.hide();
		}
		// The undo copy lives in memory; a run that rewrote a huge vault is
		// not worth holding hundreds of megabytes for.
		let kept = 0;
		for (const r of records) kept += r.original.length + r.written.length;
		const undoable = records.length > 0 && kept <= 25_000_000;
		this.lastVaultRun = undoable ? records : null;
		const skipped = total - records.length;
		new Notice(
			`Linkosaurus: linked ${records.length} note${records.length === 1 ? "" : "s"}.` +
				(skipped > 0
					? ` ${skipped} skipped because they were opened or changed meanwhile.`
					: "") +
				(undoable
					? " Run “Undo last vault-wide link” to take it back."
					: records.length > 0
						? " The run was too large to keep an undo copy."
						: "")
		);
	}

	// Puts back every note of the last vault-wide run that has not been
	// edited since. Notes changed afterwards are left alone — undoing those
	// would throw away the newer edit.
	private async undoVaultRun() {
		const records = this.lastVaultRun;
		if (!records) {
			new Notice("Linkosaurus: there is no vault-wide run to undo.");
			return;
		}
		if (this.relinking) {
			new Notice("Linkosaurus: linking all notes is running; try again when it is done.");
			return;
		}
		this.relinking = true;
		let restored = 0;
		let kept = 0;
		try {
			const vault = this.app.vault as unknown as {
				process?: (
					file: TFile,
					fn: (data: string) => string
				) => Promise<string>;
			};
			for (const rec of records) {
				if (this.unloaded) break;
				// The file may have been deleted or renamed away.
				const live = this.app.vault.getAbstractFileByPath(rec.file.path);
				if (live !== rec.file) {
					kept++;
					continue;
				}
				let didRestore = false;
				try {
					if (typeof vault.process === "function") {
						await vault.process.call(this.app.vault, rec.file, (data: string) => {
							if (data !== rec.written) return data;
							didRestore = true;
							return rec.original;
						});
					} else {
						const data = await this.app.vault.read(rec.file);
						if (data === rec.written) {
							await this.app.vault.modify(rec.file, rec.original);
							didRestore = true;
						}
					}
				} catch (error) {
					console.error(`Linkosaurus: could not restore ${rec.file.path}`, error);
				}
				if (didRestore) restored++;
				else kept++;
			}
		} finally {
			this.relinking = false;
		}
		this.lastVaultRun = null;
		new Notice(
			`Linkosaurus: restored ${restored} note${restored === 1 ? "" : "s"}.` +
				(kept > 0
					? ` ${kept} left as they are because they changed after linking.`
					: "")
		);
	}

	// Debounced by 2 s, but never postponed for more than 5 s in total, so
	// a stream of changes (sync, bulk rename) cannot starve the index.
	private scheduleScan(immediate = false) {
		if (this.unloaded || !this.settings.scanVaultLinks) return;
		const now = Date.now();
		if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
		else this.scanFirstRequest = now;
		const delay = immediate
			? 0
			: Math.max(0, Math.min(2000, this.scanFirstRequest + 5000 - now));
		this.scanTimer = window.setTimeout(() => {
			this.scanTimer = null;
			this.scanVaultLinks();
		}, delay);
	}

	// What a note contributes to the keyword index: its name, its aliases
	// and the names it links to.
	private keywordSignature(file: TFile): string {
		const cache = this.app.metadataCache.getFileCache(file);
		const parts: string[] = [file.basename];
		if (this.settings.scanFrontmatterAliases && cache?.frontmatter) {
			parts.push(...frontmatterAliases(cache.frontmatter));
		}
		parts.push("\u0001");
		if (cache?.links) {
			const links = cache.links.map((l) => l.link);
			links.sort();
			parts.push(...links);
		}
		return hashStrings(parts);
	}

	private keywordSignatureChanged(file: TFile): boolean {
		if (!this.settings.scanVaultLinks) return false;
		if (file.extension !== "md") return false;
		if (!this.passesFolderFilter(file.path)) {
			this.keywordSignatures.delete(file.path);
			return false;
		}
		const next = this.keywordSignature(file);
		const previous = this.keywordSignatures.get(file.path);
		this.keywordSignatures.set(file.path, next);
		return previous !== next;
	}

	// Drops per-path caches for a note that was deleted or moved away.
	private forgetPath(path: string) {
		this.keywordSignatures.delete(path);
		this.relinkSkip.delete(path);
		this.frontmatterSnapshots.delete(path);
	}

	private scanVaultLinks() {
		const seen = new Set<string>();
		this.vaultEntries = [];
		const signatures = new Map<string, string>();

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.passesFolderFilter(file.path)) continue;
			signatures.set(file.path, this.keywordSignature(file));

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
				for (const alias of frontmatterAliases(cache.frontmatter)) {
					const a = alias.trim();
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

		this.keywordSignatures = signatures;
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
				// Folded, so blocking "Zurich" also blocks "Zürich" — a block
				// that only covered one spelling would be defeated by the
				// folded index it is meant to constrain.
				this.blocklistSet.add(this.foldKey(line));
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

		// "@" is not a URL character, so the backwards scan stops inside an
		// email address and would otherwise link its domain on its own. This
		// guard holds whether or not email linking is enabled.
		if (isEmailBoundary(textBefore, start)) return null;

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
			// Ends at whitespace, at Markdown or HTML that closes around the
			// address (**…**, "…", <…>, `…`, […]) and at a ")" that has no
			// "(" inside the URL — Wikipedia's "Foo_(bar)" keeps its own.
			let end = i;
			let parens = 0;
			for (; end < text.length; end++) {
				const c = text.charAt(end);
				if (/[\s<>"`*\]]/.test(c)) break;
				if (c === "(") parens++;
				else if (c === ")" && parens-- === 0) break;
			}
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

		if (isWordChar(prevChar)) return null;
		// Same guard as the typing path: never link the domain half of an
		// email address as if it stood alone.
		if (isEmailBoundary(text, i)) return null;

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

	private folderListCache: { raw: string; folders: string[] } | null = null;

	// Parsed once per distinct setting value; asked for every file.
	private folderList(): string[] {
		const raw = this.settings.folderFilter;
		if (this.folderListCache?.raw !== raw) {
			this.folderListCache = { raw, folders: parseFolderList(raw) };
		}
		return this.folderListCache.folders;
	}

	private passesFolderFilter(path: string): boolean {
		return passesFolderFilter(
			path,
			this.folderList(),
			this.settings.folderFilterMode
		);
	}

	private rebuildEntries() {
		const minLen = this.settings.minKeywordLength;

		this.entries = [];
		this.lookupMap = new Map();
		this.ambiguousKeys = new Set();

		// Entry insertion is deduped on the exact keyword, never on the folded
		// one — folding that key would silently drop Zurich.md the moment
		// Zürich.md was seen first, losing a link target outright.
		const seenExact = new Set<string>();
		const keyTarget = new Map<string, string>();

		const add = (entry: KeywordEntry, manual: boolean) => {
			const exact = this.normalize(entry.keyword);
			if (seenExact.has(exact)) return;

			const folded = this.foldVariantsCached(entry.keyword);
			if (folded.length === 0) return;

			if (!manual) {
				if (minLen > 0 && entry.keyword.length < minLen) return;
				// Blocking a keyword blocks every spelling of it, otherwise
				// the folded index would quietly defeat the block.
				if (folded.some((v) => this.blocklistSet.has(v))) return;
			}

			seenExact.add(exact);
			this.entries.push({
				...entry,
				folded,
				exact,
				targetNorm: this.normalize(entry.target),
				// Compared against the raw keyword, not its normalized form:
				// this decides whether offsets found in the folded string are
				// valid positions in the keyword the popup renders.
				foldedIdentity: folded[0]!.length === entry.keyword.length,
			});

			for (const key of folded) {
				const previous = keyTarget.get(key);
				if (previous === undefined) {
					keyTarget.set(key, entry.target);
					this.lookupMap.set(key, entry.target);
				} else if (
					this.normalize(previous) !== this.normalize(entry.target)
				) {
					// Two different notes reduce to the same spelling.
					this.ambiguousKeys.add(key);
				}
			}
		};

		for (const entry of this.manualEntries) add(entry, true);
		if (this.settings.scanVaultLinks) {
			for (const entry of this.vaultEntries) add(entry, false);
		}

		this.entries.sort((a, b) => b.keyword.length - a.keyword.length);
		this.buildBuckets();
		this.bumpIndexGeneration();
	}

	private bumpIndexGeneration() {
		const s = this.settings;
		const parts: string[] = [
			String(s.caseInsensitive),
			String(s.foldDiacritics),
			s.foldLanguageMode,
			s.foldLanguages,
			String(s.urlAutolinkEnabled),
			String(s.emailAutolinkEnabled),
			s.urlAutolinkTlds,
			s.singleWordDelimiter,
			s.multiWordDelimiter,
		];
		// The keyword too: without case sensitivity "ml" and "ML" share a key,
		// but the popup shows (and inserts) the spelling.
		for (const e of this.entries) parts.push(e.exact, e.target, e.keyword);
		const signature = hashStrings(parts) + ":" + this.entries.length;
		if (signature === this.indexSignature) return;
		this.indexSignature = signature;
		this.indexGeneration++;
	}

	// Longest-match-wins: the matchers walk keyLengths from the longest
	// down and look each slice up in byKey. Within one key, candidates keep
	// the entries' order — manual entries were inserted first, so they win
	// over vault entries with the same spelling.
	private buildBuckets() {
		this.byKey = new Map();
		this.byExact = new Map();
		for (const entry of this.entries) this.byExact.set(entry.exact, entry);
		const lengths = new Set<number>();
		const growPrefixes = new Set<string>();
		const growNext = new Set<string>();

		for (const entry of this.entries) {
			for (const key of entry.folded) {
				if (!key) continue;
				const folded: FoldedKey = {
					entry,
					key,
					ambiguous: this.ambiguousKeys.has(key),
				};
				const list = this.byKey.get(key);
				if (list) list.push(folded);
				else this.byKey.set(key, [folded]);
				lengths.add(key.length);
				// Every "words so far" prefix of a multi-word keyword, so the
				// pending-undo logic can ask in O(1) whether a match could
				// still grow into a longer keyword.
				for (let p = key.indexOf(" "); p > 0; p = key.indexOf(" ", p + 1)) {
					growPrefixes.add(key.substring(0, p));
					if (p + 1 < key.length) growNext.add(key.substring(0, p + 2));
				}
			}
		}
		this.growPrefixes = growPrefixes;
		this.growNext = growNext;

		this.keyLengths = [...lengths].sort((a, b) => b - a);
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
			// Code, math, #tags, %%comments%%, frontmatter and HTML are not
			// prose; a link inserted there breaks them.
			if (/code|math|hashtag|comment|frontmatter|html/i.test(node.name))
				return true;
			if (!node.parent || node.parent === node) break;
			node = node.parent;
		}

		// The syntax tree may not have parsed that far yet, so the
		// frontmatter block is also checked by position.
		const doc = view.state.doc;
		const fmClose = frontmatterCloseLine(
			(n) => doc.line(n).text,
			doc.lines
		);
		if (fmClose !== -1 && pos <= doc.line(fmClose).to) return true;

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

	// Inside a Markdown link that is still being typed — its text
	// "[Berlin and …" or its destination "](https://…/Berlin". The syntax
	// tree only knows the link once it is closed.
	private isInsideMarkdownLink(textBefore: string): boolean {
		const dest = textBefore.lastIndexOf("](");
		if (dest !== -1 && textBefore.indexOf(")", dest + 2) === -1) return true;
		const open = textBefore.lastIndexOf("[");
		return open !== -1 && textBefore.indexOf("]", open) === -1;
	}

	private isInsideLink(textBefore: string): boolean {
		return (
			this.isInsideWikilink(textBefore) ||
			this.isInsideMarkdownLink(textBefore)
		);
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

		const target = this.lookupMap.get(this.foldKey(targetKw));
		if (target === undefined) return null;

		const preceding = textBefore.substring(0, idx);
		let displayStart = 0;
		for (let j = preceding.length - 1; j >= 0; j--) {
			if (!isWordChar(preceding.charAt(j))) {
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

		const target = this.lookupMap.get(this.foldKey(targetKw));
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
			if (!isWordChar(preceding.charAt(j))) {
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
		if (isWordChar(before)) return null;
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

	// Entries in alphabetical order, built once per index generation for the
	// empty-query popup.
	private sortedEntries: IndexedEntry[] | null = null;
	private sortedGeneration = -1;
	// What the previous query matched, so typing one more character only
	// re-checks those instead of every keyword.
	private lastSuggest: {
		query: string;
		foldedQuery: string;
		self: string | null;
		generation: number;
		matched: IndexedEntry[];
	} | null = null;

	private alphabeticalEntries(): IndexedEntry[] {
		if (
			this.sortedEntries === null ||
			this.sortedGeneration !== this.indexGeneration
		) {
			const collator = new Intl.Collator(undefined, {
				sensitivity: "base",
				numeric: true,
			});
			this.sortedEntries = [...this.entries].sort((a, b) =>
				collator.compare(a.keyword, b.keyword)
			);
			this.sortedGeneration = this.indexGeneration;
		}
		return this.sortedEntries;
	}

	getAliasSuggestions(
		query: string,
		activeFile: TFile | null,
		limit = Number.POSITIVE_INFINITY
	): AliasSuggestion[] {
		const selfNorm = activeFile
			? this.normalize(activeFile.basename)
			: null;
		const notSelf = (e: IndexedEntry) =>
			selfNorm === null || e.targetNorm !== selfNorm;

		if (!query) {
			const out: AliasSuggestion[] = [];
			for (const entry of this.alphabeticalEntries()) {
				if (out.length >= limit) break;
				if (notSelf(entry)) out.push({ entry, match: null });
			}
			return out;
		}

		const fuzzy = prepareFuzzySearch(query);
		const foldedQuery = this.foldKey(query);
		const fuzzyFolded =
			this.settings.foldDiacritics && foldedQuery
				? prepareFuzzySearch(foldedQuery)
				: null;

		// A longer query only ever matches a subset of what the shorter one
		// matched, so narrowing from the previous result is exact.
		const last = this.lastSuggest;
		const pool =
			last &&
			last.generation === this.indexGeneration &&
			last.self === selfNorm &&
			query.startsWith(last.query) &&
			foldedQuery.startsWith(last.foldedQuery)
				? last.matched
				: this.entries;

		type Scored = {
			entry: IndexedEntry;
			match: SearchResult | null;
			score: number;
		};
		// The best `limit` results, kept sorted by score; ties keep index
		// order, like the stable full sort this replaces.
		const top: Scored[] = [];
		const matched: IndexedEntry[] = [];
		const offer = (item: Scored) => {
			if (top.length >= limit) {
				const worst = top[top.length - 1]!;
				if (item.score <= worst.score) return;
			}
			let i = top.length;
			while (i > 0 && top[i - 1]!.score < item.score) i--;
			top.splice(i, 0, item);
			if (top.length > limit) top.pop();
		};

		for (const entry of pool) {
			if (!notSelf(entry)) continue;
			const match = fuzzy(entry.keyword);
			if (match) {
				matched.push(entry);
				offer({ entry, match, score: match.score });
				continue;
			}
			// Second pass for keywords that folding actually changes, so
			// typing "Lukasz" still surfaces "Łukasz".
			if (!fuzzyFolded || entry.folded[0] === entry.exact) continue;
			const foldedMatch = fuzzyFolded(entry.folded[0]!);
			if (!foldedMatch) continue;
			matched.push(entry);
			offer({
				entry,
				// The highlight offsets point into the folded string; they are
				// only valid positions in the raw keyword when the fold kept
				// its length. Otherwise render the row without highlights.
				match: entry.foldedIdentity ? foldedMatch : null,
				score: foldedMatch.score - 1,
			});
		}

		this.lastSuggest = {
			query,
			foldedQuery,
			self: selfNorm,
			generation: this.indexGeneration,
			matched,
		};
		return top.map(({ entry, match }) => ({ entry, match }));
	}

	// displayText null means note-search mode: the typed query was only a
	// filter and is replaced entirely, mirroring the keyword-autolink format
	// (mapping entries keep their keyword as alias).
	applyAliasSuggestion(
		context: EditorSuggestContext,
		entry: KeywordEntry,
		displayText: string | null
	) {
		const insert =
			displayText === null
				? formatWikilink(entry.keyword, entry.target)
				: formatAliasLink(entry.target, displayText);
		if (!insert) return;

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
				false,
				{ explicit: true }
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
		if (pos > 0 && isWordChar(text.charAt(pos - 1))) return null;

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

		const target = this.lookupMap.get(this.foldKey(targetKw));
		if (target === undefined) return null;
		if (skipNorm && this.normalize(target) === skipNorm) return null;

		const replacement = formatAliasLink(target, displayText);
		if (!replacement) return null;
		return { replacement, end: targetEnd };
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

		const target = this.lookupMap.get(this.foldKey(targetKw));
		if (target === undefined) return null;
		if (skipNorm && this.normalize(target) === skipNorm) return null;

		const replacement = formatAliasLink(target, displayText);
		if (!replacement) return null;
		return { replacement, end: targetEnd };
	}

	private matchKeyword(
		textBefore: string
	): {
		keyword: string;
		target: string;
		start: number;
		typedText: string;
	} | null {
		if (!textBefore) return null;
		const maxKeyLen = this.keyLengths[0];
		if (maxKeyLen === undefined) return null;

		// Only the tail of the line can hold a keyword ending at the cursor,
		// so only that tail is folded — a long paragraph is no longer folded
		// in full on every keystroke. The factor leaves room for characters
		// that fold away (combining marks); the cut is moved off surrogate
		// pairs and combining marks so it lands on a character boundary.
		let cut = Math.max(0, textBefore.length - (maxKeyLen * 3 + 2));
		while (cut > 0) {
			const code = textBefore.charCodeAt(cut);
			if (code >= 0xdc00 && code <= 0xdfff) cut--;
			else if (/\p{M}/u.test(textBefore.charAt(cut))) cut--;
			else break;
		}
		const folded = foldWithMap(textBefore.substring(cut), this.foldTable);
		const text = folded.folded;
		if (!text) return null;

		for (const kwLen of this.keyLengths) {
			if (text.length < kwLen) continue;
			const foldedStart = text.length - kwLen;
			const candidates = this.byKey.get(text.substring(foldedStart));
			if (!candidates) continue;
			// Refuse a match that begins inside an expansion such as ß → ss;
			// replacing from there would eat half a character.
			if (!isFoldBoundary(folded, foldedStart)) continue;

			const start = cut + toSrcIndex(folded, foldedStart);
			if (start > 0) {
				const ch = textBefore.charAt(start - 1);
				if (isWordChar(ch)) continue;
			}
			// "#Berlin" is a tag, not a mention of the note Berlin.
			if (endsInHashtag(textBefore.substring(0, start))) continue;
			// "^Berlin" is a block id, "[^Berlin" a footnote label.
			if (textBefore.charAt(start - 1) === "^") continue;
			if (textBefore.substring(start, start + 2) === "[[") continue;
			if (
				start >= 2 &&
				textBefore.substring(start - 2, start) === "[["
			)
				continue;

			for (const { entry, ambiguous } of candidates) {
				// Two notes folding to the same spelling only match on the
				// exact one, so "Zurich" never links [[Zürich]] when both
				// exist.
				if (
					ambiguous &&
					this.normalize(textBefore.substring(start)) !== entry.exact
				)
					continue;

				return {
					keyword: entry.keyword,
					target: entry.target,
					start,
					typedText: textBefore.substring(start),
				};
			}
		}

		return null;
	}

	getVaultKeywords(): string[] {
		return this.vaultEntries
			.map((e) => e.keyword)
			.sort((a, b) => a.localeCompare(b));
	}

	// Gives a focused property value field its own suggestion popup. The
	// element lookup is the one part not covered by the public API, so it
	// stays defensive: no match simply means no popup, never an error.
	private attachPropertySuggest(target: EventTarget | null) {
		if (!this.settings.noteSearchEnabled) return;
		if (!(target instanceof HTMLElement)) return;
		if (this.propertySuggestFields.has(target)) return;
		if (!isPropertyValueField(target)) return;

		const Suggest = getPropertySuggestCtor();
		if (!Suggest) return;

		this.propertySuggestFields.add(target);
		for (const entry of this.propertySuggests) {
			if (!entry.field.isConnected) this.propertySuggests.delete(entry);
		}
		const suggest = new Suggest(
			this.app,
			this,
			target as HTMLInputElement | HTMLDivElement
		);
		this.propertySuggests.add({ field: target, suggest });
	}

	// Property fields are not part of the editor, so there is no keystroke to
	// hook: Obsidian saves the note and the metadata cache reports it. The
	// work is deferred until the field no longer has focus, which is the
	// moment the value is finished rather than half-typed.
	private schedulePropertyLink(file: TFile) {
		if (!this.settings.propertyLinkEnabled) return;
		if (!this.settings.propertyLinkOnEdit) return;
		if (file.extension !== "md") return;
		if (this.propertyLinkWrites.has(file.path)) {
			this.rememberFrontmatter(file);
			return;
		}
		// Only the note in front of the user. A change arriving from sync or
		// another plugin must never cascade edits across the vault.
		if (this.app.workspace.getActiveFile()?.path !== file.path) return;
		// Typing in the body saves the note too; only a changed property is
		// work for us. Without a snapshot (first save seen) it runs as before.
		const previous = this.frontmatterSnapshots.get(file.path);
		const current = this.rememberFrontmatter(file);
		if (previous !== undefined && previous === current) return;

		this.pendingPropertyLinks.set(file.path, file);
		this.armPropertyLinkTimer(file);
	}

	private rememberFrontmatter(file: TFile): string {
		const snapshot = frontmatterSnapshot(
			this.app.metadataCache.getFileCache(file)?.frontmatter
		);
		// Only the notes the user had open matter; keep the map small.
		if (this.frontmatterSnapshots.size > 200) this.frontmatterSnapshots.clear();
		this.frontmatterSnapshots.set(file.path, snapshot);
		return snapshot;
	}

	private armPropertyLinkTimer(file: TFile) {
		const pending = this.propertyLinkTimers.get(file.path);
		if (pending !== undefined) window.clearTimeout(pending);
		this.propertyLinkTimers.set(
			file.path,
			window.setTimeout(() => {
				this.propertyLinkTimers.delete(file.path);
				// Waiting, never dropping: Obsidian saves a property the
				// moment focus moves to the next field, so the work is
				// usually queued while the cursor still sits in the panel.
				if (
					nextPropertyLinkAction({
						focusInProperties: this.isEditingProperties(),
					}) === "wait"
				) {
					this.armPropertyLinkTimer(file);
					return;
				}
				this.pendingPropertyLinks.delete(file.path);
				void this.linkProperties(file, false);
			}, 400)
		);
	}

	// Runs everything queued — used when focus leaves the property panel or
	// the note is closed, so a finished value does not wait for the timer.
	private flushPropertyLinks() {
		if (this.isEditingProperties()) return;
		for (const [path, file] of [...this.pendingPropertyLinks]) {
			const timer = this.propertyLinkTimers.get(path);
			if (timer !== undefined) window.clearTimeout(timer);
			this.propertyLinkTimers.delete(path);
			this.pendingPropertyLinks.delete(path);
			void this.linkProperties(file, false);
		}
	}

	// True while the cursor sits in a property field, so a value is never
	// rewritten out from under the person typing it.
	private isEditingProperties(): boolean {
		if (this.isEditingFrontmatterText()) return true;
		const active = document.activeElement;
		if (!(active instanceof HTMLElement)) return false;
		return active.closest(".metadata-container, .metadata-property") !== null;
	}

	// The same for properties edited as YAML (source mode, or properties
	// shown as source): the focused editor's cursor sits in the frontmatter.
	private isEditingFrontmatterText(): boolean {
		const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
		if (!editor || !editor.hasFocus()) return false;
		const close = frontmatterCloseLine(
			(n) => editor.getLine(n - 1),
			editor.lineCount()
		);
		// close is 1-based, cursor lines 0-based: the closing "---" counts.
		return close !== -1 && editor.getCursor().line < close;
	}

	private propertyMatcher(selfName: string): PropertyMatcher {
		const prefixMatchEnabled = this.settings.propertyLinkPrefixMatch;
		return {
			lookup: (value: string) => {
				const key = this.foldKey(value);
				const target = this.lookupMap.get(key);
				if (target === undefined) return undefined;
				// Two notes folding to the same spelling only match on the
				// exact one, the same rule the typing path follows so
				// "Zurich" never links [[Zürich]] when both exist.
				if (this.ambiguousKeys.has(key)) {
					return this.byExact.get(this.normalize(value))?.target;
				}
				return target;
			},
			prefixCandidates: (value: string) => {
				const key = this.foldKey(value);
				if (!key) return [];
				const seen = new Set<string>();
				const out: string[] = [];
				for (const entry of this.entries) {
					// folded[0] is foldKey(keyword), computed with the index.
					if (!entry.folded[0]!.startsWith(key)) continue;
					const targetKey = entry.targetNorm;
					if (seen.has(targetKey)) continue;
					seen.add(targetKey);
					out.push(entry.target);
				}
				return out;
			},
			selfName,
			foldKey: (text: string) => this.foldKey(text),
			exactKey: (text: string) => this.normalize(text),
			prefixMatchEnabled,
			propertyType: (name: string) => this.propertyType(name),
		};
	}

	// The type Obsidian assigned to a property (1.4+). Not public API, so
	// the lookup is guarded; no answer means "unknown", which is allowed.
	private propertyType(name: string): string | undefined {
		const manager = (
			this.app as unknown as {
				metadataTypeManager?: {
					getAssignedType?: (name: string) => unknown;
				};
			}
		).metadataTypeManager;
		try {
			const type = manager?.getAssignedType?.(name);
			return typeof type === "string" ? type : undefined;
		} catch {
			return undefined;
		}
	}

	// Frontmatter writing arrived in Obsidian 1.4.4, well after this plugin's
	// minAppVersion, and so did the property editor this feature exists for.
	// The guarded lookup keeps the plugin loadable on older versions, where
	// the feature simply reports itself as unavailable.
	private frontMatterWriter():
		| ((
				file: TFile,
				fn: (frontmatter: Record<string, unknown>) => void
		  ) => Promise<void>)
		| null {
		const manager = this.app.fileManager as unknown as {
			processFrontMatter?: (
				file: TFile,
				fn: (frontmatter: Record<string, unknown>) => void
			) => Promise<void>;
		};
		return typeof manager.processFrontMatter === "function"
			? manager.processFrontMatter.bind(manager)
			: null;
	}

	async linkProperties(file: TFile, showNotice: boolean): Promise<void> {
		if (!this.settings.propertyLinkEnabled) {
			if (showNotice) {
				new Notice(
					"Linkosaurus: turn on “Link property values” in settings first."
				);
			}
			return;
		}

		if (!this.allowsLinksIn(file)) {
			if (showNotice) {
				new Notice(
					"Linkosaurus: this note is excluded from linking (folder or linkosaurus: false)."
				);
			}
			return;
		}

		const allowed = parsePropertyList(this.settings.propertyLinkFields);
		const matcher = this.propertyMatcher(file.basename);

		// processFrontMatter would add an empty frontmatter block to a note
		// that has none, so the cached metadata decides whether the file is
		// worth opening at all. The values are matched again inside the
		// callback, which is what actually gets written.
		const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!cached || Object.keys(cached).length === 0) {
			if (showNotice) {
				new Notice("Linkosaurus: this note has no properties.");
			}
			return;
		}

		const preview = linkFrontmatter(cached, allowed, matcher);
		if (preview.size === 0) {
			if (showNotice) {
				const names = Object.keys(cached).filter((name) =>
					isLinkableProperty(name, allowed)
				);
				new Notice(
					names.length === 0
						? "Linkosaurus: none of this note's properties are on the list to link."
						: "Linkosaurus: no property value matched a note."
				);
			}
			return;
		}

		const writeFrontMatter = this.frontMatterWriter();
		if (!writeFrontMatter) {
			if (showNotice) {
				new Notice(
					"Linkosaurus: linking properties needs Obsidian 1.4.4 or newer."
				);
			}
			return;
		}

		let changed = 0;
		this.propertyLinkWrites.add(file.path);
		try {
			await writeFrontMatter(
				file,
				(frontmatter: Record<string, unknown>) => {
					const changes = linkFrontmatter(
						frontmatter,
						allowed,
						matcher
					);
					for (const [key, value] of changes) {
						frontmatter[key] = value;
					}
					changed = changes.size;
				}
			);
		} catch (error) {
			console.error("Linkosaurus: could not update properties", error);
			if (showNotice) {
				new Notice("Linkosaurus: could not update the properties.");
			}
			this.propertyLinkWrites.delete(file.path);
			return;
		}

		// The write comes back through the metadata cache; ignore that echo.
		const echoTimer = window.setTimeout(() => {
			this.propertyEchoTimers.delete(echoTimer);
			this.propertyLinkWrites.delete(file.path);
		}, 1000);
		this.propertyEchoTimers.add(echoTimer);

		if (showNotice && changed > 0) {
			new Notice(
				`Linkosaurus: linked ${changed} propert${changed === 1 ? "y" : "ies"}.`
			);
		}
	}

	debouncedSave() {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		// Text fields only store their value; parsing and saving happen
		// together once typing pauses.
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveSettings();
		}, 300);
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
		if (typeof this.settings.neverLinkFolders !== "string")
			this.settings.neverLinkFolders = "";
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
		if (typeof this.settings.emailAutolinkEnabled !== "boolean")
			this.settings.emailAutolinkEnabled = DEFAULT_SETTINGS.emailAutolinkEnabled;
		if (typeof this.settings.propertyLinkEnabled !== "boolean")
			this.settings.propertyLinkEnabled = DEFAULT_SETTINGS.propertyLinkEnabled;
		if (typeof this.settings.propertyLinkFields !== "string")
			this.settings.propertyLinkFields = DEFAULT_SETTINGS.propertyLinkFields;

		// Stored settings win over new defaults, so a vault that installed
		// 4.3.0 would keep property linking switched off for good. Settings
		// written before the schema marker are put back to the defaults once.
		const migrated = migratePropertySettings({
			version: (loaded as { settingsVersion?: unknown } | null)
				?.settingsVersion,
			enabled: this.settings.propertyLinkEnabled,
			fields: this.settings.propertyLinkFields,
		});
		const migrationChanged =
			migrated.version !== this.settings.settingsVersion ||
			migrated.enabled !== this.settings.propertyLinkEnabled ||
			migrated.fields !== this.settings.propertyLinkFields;
		this.settings.settingsVersion = migrated.version;
		this.settings.propertyLinkEnabled = migrated.enabled;
		this.settings.propertyLinkFields = migrated.fields;
		if (migrationChanged) await this.saveData(this.settings);
		if (typeof this.settings.propertyLinkOnEdit !== "boolean")
			this.settings.propertyLinkOnEdit = DEFAULT_SETTINGS.propertyLinkOnEdit;
		if (typeof this.settings.propertyLinkPrefixMatch !== "boolean")
			this.settings.propertyLinkPrefixMatch = DEFAULT_SETTINGS.propertyLinkPrefixMatch;
		if (typeof this.settings.urlAutolinkTlds !== "string")
			this.settings.urlAutolinkTlds = DEFAULT_SETTINGS.urlAutolinkTlds;
		if (typeof this.settings.foldDiacritics !== "boolean")
			this.settings.foldDiacritics = DEFAULT_SETTINGS.foldDiacritics;
		if (
			this.settings.foldLanguageMode !== "all" &&
			this.settings.foldLanguageMode !== "selected"
		)
			this.settings.foldLanguageMode = DEFAULT_SETTINGS.foldLanguageMode;
		if (typeof this.settings.foldLanguages !== "string")
			this.settings.foldLanguages = DEFAULT_SETTINGS.foldLanguages;
		this.settings.periodicRelinkIntervalMinutes = clampRelinkInterval(
			this.settings.periodicRelinkIntervalMinutes
		);
		this.rebuildFoldTable();
		// onload parses everything right after this; that is the baseline
		// later saves are compared with.
		this.appliedSettings = { ...this.settings };
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applySettings();
	}

	// Brings the derived state (fold table, keyword index, TLDs) in line
	// with the settings — but only the parts a changed setting touches.
	// Toggling a popup option no longer rebuilds the index and rescans the
	// vault.
	private applySettings() {
		const current = { ...this.settings } as unknown as Record<string, unknown>;
		const changed = changedSettingKeys(this.appliedSettings, current);
		this.appliedSettings = current;
		if (changed.size === 0) return;

		if (affectsIndex(changed)) {
			// Order matters: the blocklist and the keyword index are both
			// folded with the current table, so the table comes first.
			this.rebuildFoldTable();
			this.parseBlocklist();
			this.parseManualKeywords();
			if (this.settings.scanVaultLinks) this.scheduleScan();
		}
		if (changed.has("urlAutolinkTlds")) this.parseTlds();
		// URL/email/alias options change what the bulk linker writes.
		this.bumpIndexGeneration();
	}
}

interface AliasSuggestion {
	entry: KeywordEntry;
	match: SearchResult | null;
}

type SuggestMode = "alias" | "search";

// The suggestion popup for property fields, built the first time one is
// focused rather than at load time. Its base class arrived in Obsidian
// 1.4.10, well after this plugin's minAppVersion, and a class extending a
// missing base would fail while the plugin loads — taking everything else
// with it. Older versions have no property editor to begin with, so they
// simply never get here.
interface InputSuggestInstance {
	limit: number;
	setValue(value: string): void;
	close(): void;
}

type PropertySuggestCtor = new (
	app: App,
	plugin: AutoLinkKeywordsPlugin,
	field: HTMLInputElement | HTMLDivElement
) => InputSuggestInstance;

let propertySuggestCtor: PropertySuggestCtor | null | undefined;

function getPropertySuggestCtor(): PropertySuggestCtor | null {
	if (propertySuggestCtor !== undefined) return propertySuggestCtor;

	const api = obsidian as unknown as Record<string, unknown>;
	const Base = api.AbstractInputSuggest as
		| (new (
				app: App,
				el: HTMLInputElement | HTMLDivElement
		  ) => InputSuggestInstance)
		| undefined;
	if (typeof Base !== "function") {
		propertySuggestCtor = null;
		return null;
	}

	class PropertyValueSuggest extends Base {
	private plugin: AutoLinkKeywordsPlugin;
	private field: HTMLElement;

	constructor(
		app: App,
		plugin: AutoLinkKeywordsPlugin,
		field: HTMLInputElement | HTMLDivElement
	) {
		super(app, field);
		this.plugin = plugin;
		this.field = field;
		this.limit = 12;
	}

	protected getSuggestions(query: string): AliasSuggestion[] {
		// The listeners outlive a reload of the plugin; the old instance must
		// stay silent so the new one's popup is the only one.
		if (this.plugin.unloaded) return [];
		if (!this.plugin.settings.noteSearchEnabled) return [];

		const trigger = matchPropertySearchTrigger(
			query,
			this.plugin.settings.noteSearchTrigger
		);
		if (!trigger) return [];

		const suggestions = this.plugin.getAliasSuggestions(
			trigger.query,
			this.plugin.app.workspace.getActiveFile(),
			this.limit
		);
		return suggestions.slice(0, this.limit);
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
		const foldKey = (text: string) => this.plugin.foldKey(text);
		const keyword = sanitizeDisplay(suggestion.entry.keyword);
		let target = sanitizeTarget(suggestion.entry.target);
		// A keyword that is its own target ("C#") names the note without
		// the characters a note name cannot hold, like formatWikilink.
		if (foldKey(keyword) === foldKey(target)) {
			target = selfTargetName(target) || target;
		}
		const value = propertyLinkFromEntry(keyword, target, foldKey);

		this.setValue(value);
		// setValue writes the element; Obsidian only takes the value into its
		// own property model when the field reports an edit.
		this.field.dispatchEvent(new Event("input", { bubbles: true }));
		// Multi-select properties (list type) turn the text into a pill on
		// Enter — without it the value would sit there uncommitted.
		if (this.field.closest(".multi-select-container")) {
			this.field.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Enter",
					code: "Enter",
					bubbles: true,
				})
			);
		}
		this.close();
	}
	}

	propertySuggestCtor = PropertyValueSuggest;
	return propertySuggestCtor;
}

// The preview of "Auto-link keywords in all notes": how many notes and links,
// the notes themselves on demand, and a button to go ahead.
class VaultRunModal extends Modal {
	private plan: RelinkPlan;
	private handlers: { onConfirm: () => void; onCancel: () => void };
	private decided = false;

	constructor(
		app: App,
		plan: RelinkPlan,
		handlers: { onConfirm: () => void; onCancel: () => void }
	) {
		super(app);
		this.plan = plan;
		this.handlers = handlers;
	}

	static skippedText(plan: RelinkPlan): string {
		const parts: string[] = [];
		if (plan.skippedOpen > 0)
			parts.push(`${plan.skippedOpen} open note${plan.skippedOpen === 1 ? "" : "s"}`);
		if (plan.skippedLarge > 0)
			parts.push(
				`${plan.skippedLarge} note${plan.skippedLarge === 1 ? "" : "s"} over 100k characters`
			);
		return parts.length > 0 ? ` Skipped: ${parts.join(", ")}.` : "";
	}

	onOpen(): void {
		const { contentEl } = this;
		const { items, links } = this.plan;
		const notes = items.length;
		this.titleEl.setText("Link keywords in all notes");
		contentEl.createEl("p", {
			text:
				`${links} link${links === 1 ? "" : "s"} in ${notes} note${notes === 1 ? "" : "s"}.` +
				VaultRunModal.skippedText(this.plan),
		});

		const details = contentEl.createEl("details", {
			cls: "linkosaurus-details",
		});
		details.createEl("summary", {
			cls: "linkosaurus-details-summary",
			text: "Show notes",
		});
		const shown = items.slice(0, 500);
		details.createDiv({
			cls: "linkosaurus-details-list",
			text:
				shown.map((i) => `${i.file.path} (${i.links})`).join("\n") +
				(items.length > shown.length
					? `\n… and ${items.length - shown.length} more`
					: ""),
		});

		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Open notes are not touched. You can undo this run with the command “Undo last vault-wide link”.",
		});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((button) =>
				button
					.setButtonText(`Link ${notes} note${notes === 1 ? "" : "s"}`)
					.setCta()
					.onClick(() => {
						this.decided = true;
						this.close();
						this.handlers.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.decided) this.handlers.onCancel();
	}
}

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
			context.file ?? null,
			this.limit
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
		// open() can run again while the popup is up; never stack a second
		// pill and observer on the first.
		this.removePill();
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
			setStyles(this.pill, { opacity: "0" });
			return;
		}
		setStyles(this.pill, {
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

const NEVER_LINK_DESC =
	"Notes in these folders (one per line) are never changed — not while " +
	"typing, not by the commands. A single note opts out with the property " +
	"linkosaurus: false.";

class AutoLinkSettingTab extends PluginSettingTab {
	plugin: AutoLinkKeywordsPlugin;

	constructor(app: App, plugin: AutoLinkKeywordsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Closing the tab writes a pending text edit immediately instead of
	// leaving it to the debounce timer.
	hide() {
		this.plugin.flushPendingSave();
		super.hide();
	}

	// Declarative settings for Obsidian 1.13+: rendered by the framework and
	// indexed by the global settings search. Values are read from
	// plugin.settings by the default getControlValue; writes flow through
	// setControlValue below. Textareas stay imperative render rows so they
	// keep their monospace styling and debounced parsing.
	getSettingDefinitions(): SettingDefinitionItem[] {
		const plugin = this.plugin;
		const vaultScanOn = () => plugin.settings.scanVaultLinks;
		const foldingOn = () => plugin.settings.foldDiacritics;

		const languageGrid = (setting: Setting) => {
			setting.setName("Selected languages");
			setting.setDesc(
				"Characters outside the ticked languages are matched exactly."
			);
			this.buildLanguageGrid(setting.controlEl);
		};

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
				name: "Ignore accents and special letters",
				desc:
					"Match keywords across accents and special letters, in both " +
					"directions: typing Lukasz finds the note Łukasz, Gokhan finds " +
					"Gökhan, Zoe finds Zoë. The note's own spelling is always what " +
					"gets written into your text.",
				aliases: [
					"accents",
					"diacritics",
					"umlaut",
					"language",
					"unicode",
					"polish",
					"turkish",
					"czech",
					"french",
					"special characters",
				],
				control: {
					type: "toggle",
					key: "foldDiacritics",
					defaultValue: DEFAULT_SETTINGS.foldDiacritics,
				},
			},
			{
				name: "Languages",
				desc:
					"All languages needs no setup and has no downside for most " +
					"vaults — ł only ever means l, ğ only ever means g. Pick " +
					"individual languages only if you want to keep some spellings " +
					"matched exactly.",
				visible: foldingOn,
				aliases: ["language", "languages"],
				control: {
					type: "dropdown",
					key: "foldLanguageMode",
					defaultValue: DEFAULT_SETTINGS.foldLanguageMode,
					options: {
						all: "All languages (recommended)",
						selected: "Only selected languages",
					},
				},
			},
			{
				name: "Selected languages",
				aliases: [
					"language",
					"polish",
					"turkish",
					"german",
					"czech",
					"french",
					"spanish",
					"hungarian",
					"romanian",
					"icelandic",
					"vietnamese",
					"scandinavian",
					"danish",
					"norwegian",
					"swedish",
				],
				visible: () =>
					plugin.settings.foldDiacritics &&
					plugin.settings.foldLanguageMode === "selected",
				render: (setting: Setting) => languageGrid(setting),
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
				name: "Never link inside these folders",
				desc: NEVER_LINK_DESC,
				aliases: ["exclude", "opt out", "folders", "ignore"],
				render: (setting: Setting) =>
					monoTextArea(setting, {
						name: "Never link inside these folders",
						desc: NEVER_LINK_DESC,
						rows: 4,
						placeholder: "Templates\nArchive",
						value: () => plugin.settings.neverLinkFolders,
						onChange: (value) => {
							plugin.settings.neverLinkFolders = value;
							plugin.debouncedSave();
						},
					}),
			},
			{
				type: "group",
				heading: "Periodic auto-relink",
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
							validate: (value: number) => {
								const n = Number(value);
								if (!Number.isFinite(n) || n < 1 || n > 60)
									return "Enter a number of minutes from 1 to 60.";
								return;
							},
						},
					},
				],
			},
			{
				name: "Auto-link website URLs",
				desc:
					"Convert URLs to Markdown links while typing or pasting. " +
					"Detects http(s)://... and bare domains (e.g. example.com).",
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
				visible: () => plugin.settings.urlAutolinkEnabled,
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
							plugin.debouncedSave();
						},
					}),
			},
			{
				name: "Auto-link email addresses",
				desc:
					"Turn typed or pasted email addresses into mailto links. " +
					"Example: team@example.com → [team@example.com](mailto:team@example.com)",
				aliases: ["email", "mail", "mailto"],
				control: {
					type: "toggle",
					key: "emailAutolinkEnabled",
					defaultValue: DEFAULT_SETTINGS.emailAutolinkEnabled,
				},
			},
			{
				name: "Link property values",
				desc:
					"Link the text you type into properties like author or publisher. " +
					"Type the search trigger there for the suggestion popup, or " +
					"just write the name and leave the field. " +
					"Example: author: Museum → author: \"[[Museum of Natural History]]\"",
				aliases: ["properties", "frontmatter", "metadata"],
				control: {
					type: "toggle",
					key: "propertyLinkEnabled",
					defaultValue: DEFAULT_SETTINGS.propertyLinkEnabled,
				},
			},
			{
				name: "Properties to link",
				desc:
					"Property names to link, one per line. Leave empty for all of them. " +
					"Tags, aliases and cssclasses are never touched.",
				aliases: ["properties"],
				visible: () => plugin.settings.propertyLinkEnabled,
				render: (setting: Setting) =>
					monoTextArea(setting, {
						name: "Properties to link",
						desc:
							"Property names to link, one per line. Leave empty for all of them. " +
							"Tags, aliases and cssclasses are never touched.",
						rows: 6,
						placeholder: "author\npublisher\nrelated",
						value: () => plugin.settings.propertyLinkFields,
						onChange: (value) => {
							plugin.settings.propertyLinkFields = value;
							plugin.debouncedSave();
						},
					}),
			},
			{
				name: "Link properties after editing",
				desc:
					"Link a value as soon as you leave the property field. " +
					"Turn off to link only through the command.",
				aliases: ["properties"],
				visible: () => plugin.settings.propertyLinkEnabled,
				control: {
					type: "toggle",
					key: "propertyLinkOnEdit",
					defaultValue: DEFAULT_SETTINGS.propertyLinkOnEdit,
				},
			},
			{
				name: "Complete property names",
				desc:
					"Let a partly typed value find the note it starts — Museum finds " +
					"Museum of Natural History — as long as exactly one note matches.",
				aliases: ["properties", "prefix"],
				visible: () => plugin.settings.propertyLinkEnabled,
				control: {
					type: "toggle",
					key: "propertyLinkPrefixMatch",
					defaultValue: DEFAULT_SETTINGS.propertyLinkPrefixMatch,
				},
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
				this.plugin.settings.periodicRelinkIntervalMinutes =
					clampRelinkInterval(value);
				await this.plugin.saveSettings();
				this.plugin.startPeriodicRelink();
				return;
			default:
				await this.plugin.saveSettings();
				// Visibility of other rows hangs on several toggles and
				// dropdowns (noteSearchEnabled, aliasSuggestEnabled, …);
				// re-evaluating it after every such change keeps a
				// hand-kept list from drifting. Text and number fields are
				// left alone so a re-render never steals focus mid-typing.
				if (typeof value === "boolean" || typeof value === "string" && (key === "foldLanguageMode" || key === "folderFilterMode"))
					this.refreshDefinitions();
		}
	}

	// Shared by the declarative settings and the pre-1.13 fallback.
	private buildLanguageGrid(container: HTMLElement) {
		const plugin = this.plugin;
		const grid = container.createDiv({ cls: "linkosaurus-lang-grid" });
		const selected = parseLanguages(plugin.settings.foldLanguages);

		for (const pack of LANGUAGE_PACKS) {
			const row = grid.createEl("label", {
				cls: "linkosaurus-lang-item",
			});
			const box = row.createEl("input", { type: "checkbox" });
			box.checked = selected.has(pack.id);
			const text = row.createDiv({ cls: "linkosaurus-lang-text" });
			text.createSpan({
				cls: "linkosaurus-lang-name",
				text: pack.label,
			});
			text.createSpan({
				cls: "linkosaurus-lang-sample",
				text: pack.sample,
			});

			box.addEventListener("change", () => {
				if (box.checked) selected.add(pack.id);
				else selected.delete(pack.id);
				plugin.settings.foldLanguages = [...selected].join(",");
				// Re-index straight away so the change is live before the
				// debounced save lands.
				plugin.rebuildFoldTable();
				plugin.parseBlocklist();
				plugin.parseManualKeywords();
				plugin.debouncedSave();
			});
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
	// getSettingDefinitions() and never call this. The body lives in
	// renderLegacy() so the in-tab refreshes below don't have to call the
	// deprecated display() themselves.
	display() {
		this.renderLegacy();
	}

	private renderLegacy() {
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
			.setName("Ignore accents and special letters")
			.setDesc(
				"Match keywords across accents and special letters, in both " +
				"directions: typing Lukasz finds the note Łukasz, Gokhan finds " +
				"Gökhan. The note's own spelling is always what gets written " +
				"into your text."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.foldDiacritics)
					.onChange(async (value) => {
						this.plugin.settings.foldDiacritics = value;
						await this.plugin.saveSettings();
						this.renderLegacy();
					});
			});

		if (this.plugin.settings.foldDiacritics) {
			new Setting(containerEl)
				.setName("Languages")
				.setDesc(
					"All languages needs no setup and has no downside for most " +
					"vaults — ł only ever means l, ğ only ever means g. Pick " +
					"individual languages only if you want to keep some " +
					"spellings matched exactly."
				)
				.addDropdown((dropdown) => {
					dropdown
						.addOption("all", "All languages (recommended)")
						.addOption("selected", "Only selected languages")
						.setValue(this.plugin.settings.foldLanguageMode)
						.onChange(async (value) => {
							this.plugin.settings.foldLanguageMode =
								value === "selected" ? "selected" : "all";
							await this.plugin.saveSettings();
							this.renderLegacy();
						});
				});

			if (this.plugin.settings.foldLanguageMode === "selected") {
				const setting = new Setting(containerEl)
					.setName("Selected languages")
					.setDesc(
						"Characters outside the ticked languages are matched exactly."
					);
				this.buildLanguageGrid(setting.controlEl);
			}
		}

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
						if (
							value === this.plugin.settings.multiWordDelimiter ||
							value === this.plugin.settings.noteSearchTrigger
						) {
							setError(true);
							return;
						}
						setError(false);
						this.plugin.settings.singleWordDelimiter = value;
						await this.plugin.saveSettings();
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
						if (
							value === this.plugin.settings.singleWordDelimiter ||
							value === this.plugin.settings.noteSearchTrigger
						) {
							setError(true);
							return;
						}
						setError(false);
						this.plugin.settings.multiWordDelimiter = value;
						await this.plugin.saveSettings();
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
						this.renderLegacy();
					});
			});

		new Setting(containerEl)
			.setName("Note search popup")
			.setDesc(
				"Type the search trigger to open a popup listing every " +
				"linkable note and keyword, filtering as you type — " +
				"spaces allowed. Example: ;;feed → [[T-Rex - Feeding Schedule]]"
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.noteSearchEnabled)
					.onChange(async (value) => {
						this.plugin.settings.noteSearchEnabled = value;
						await this.plugin.saveSettings();
						this.renderLegacy();
					});
			});

		if (this.plugin.settings.noteSearchEnabled) {
			new Setting(containerEl)
				.setName("Search trigger")
				.setDesc("Characters that open the note search popup.")
				.setClass("linkosaurus-input-delim")
				.addText((text) => {
					const setError = (on: boolean) =>
						text.inputEl.toggleClass("linkosaurus-input-error", on);
					text.setPlaceholder(";;")
						.setValue(this.plugin.settings.noteSearchTrigger)
						.onChange(async (value) => {
							if (
								!value ||
								value === this.plugin.settings.singleWordDelimiter ||
								value === this.plugin.settings.multiWordDelimiter
							) {
								setError(true);
								return;
							}
							setError(false);
							this.plugin.settings.noteSearchTrigger = value;
							await this.plugin.saveSettings();
						});
				});
		}

		if (
			this.plugin.settings.aliasSuggestEnabled ||
			this.plugin.settings.noteSearchEnabled
		) {
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
						this.renderLegacy();
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

			this.buildVaultDetails(containerEl);
		}

		new Setting(containerEl)
			.setName("Never link inside these folders")
			.setDesc(NEVER_LINK_DESC)
			.setClass("linkosaurus-textarea-mono")
			.addTextArea((text) => {
				text.inputEl.rows = 4;
				text.setPlaceholder("Templates\nArchive")
					.setValue(this.plugin.settings.neverLinkFolders)
					.onChange((value) => {
						this.plugin.settings.neverLinkFolders = value;
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
						this.renderLegacy();
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
						this.renderLegacy();
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
							this.plugin.debouncedSave();
						});
				});
		}

		new Setting(containerEl)
			.setName("Auto-link email addresses")
			.setDesc(
				"Turn typed or pasted email addresses into mailto links. " +
				"Example: team@example.com → [team@example.com](mailto:team@example.com)"
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.emailAutolinkEnabled)
					.onChange(async (value) => {
						this.plugin.settings.emailAutolinkEnabled = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Link property values")
			.setDesc(
				"Link the text you type into properties like author or publisher. " +
				"Type the search trigger there for the suggestion popup, or " +
				"just write the name and leave the field. " +
				"Example: author: Museum → author: \"[[Museum of Natural History]]\""
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.propertyLinkEnabled)
					.onChange(async (value) => {
						this.plugin.settings.propertyLinkEnabled = value;
						await this.plugin.saveSettings();
						this.renderLegacy();
					});
			});

		if (this.plugin.settings.propertyLinkEnabled) {
			new Setting(containerEl)
				.setName("Properties to link")
				.setDesc(
					"Property names to link, one per line. Leave empty for all of them. " +
					"Tags, aliases and cssclasses are never touched."
				)
				.setClass("linkosaurus-textarea-mono")
				.addTextArea((text) => {
					text.inputEl.rows = 6;
					text.setPlaceholder("author\npublisher\nrelated")
						.setValue(this.plugin.settings.propertyLinkFields)
						.onChange((value) => {
							this.plugin.settings.propertyLinkFields = value;
							this.plugin.debouncedSave();
						});
				});

			new Setting(containerEl)
				.setName("Link properties after editing")
				.setDesc(
					"Link a value as soon as you leave the property field. " +
					"Turn off to link only through the command."
				)
				.addToggle((toggle) => {
					toggle
						.setValue(this.plugin.settings.propertyLinkOnEdit)
						.onChange(async (value) => {
							this.plugin.settings.propertyLinkOnEdit = value;
							await this.plugin.saveSettings();
						});
				});

			new Setting(containerEl)
				.setName("Complete property names")
				.setDesc(
					"Let a partly typed value find the note it starts — Museum finds " +
					"Museum of Natural History — as long as exactly one note matches."
				)
				.addToggle((toggle) => {
					toggle
						.setValue(this.plugin.settings.propertyLinkPrefixMatch)
						.onChange(async (value) => {
							this.plugin.settings.propertyLinkPrefixMatch = value;
							await this.plugin.saveSettings();
						});
				});
		}
	}
}
