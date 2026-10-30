import test from "node:test";
import assert from "node:assert/strict";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import AutoLinkKeywordsPlugin from "../src/main";
import { buildFoldTable, fold } from "../src/fold";

// The typing path schedules its pending undo with window.setTimeout.
const g = globalThis as unknown as { window?: unknown };
g.window ??= globalThis;

type Internals = {
	handleInput(v: unknown, from: number, to: number, text: string): boolean;
	handleEditorUpdate(v: unknown, docChanged: boolean, sel: boolean, changes: unknown): void;
	handlePaste(e: unknown, v: unknown): boolean;
	replaceKeywordsInText(text: string, charBefore: string, charAfter: string): string;
	scanVaultLinks(): void;
	getVaultKeywords(): string[];
	clearPendingUndo(): void;
};

function plugin(keywords: string, over: Record<string, unknown> = {}, app?: unknown) {
	const p = new AutoLinkKeywordsPlugin(
		(app ?? { workspace: { getActiveFile: () => null } }) as never,
		{} as never
	);
	Object.assign(p.settings, { scanVaultLinks: false, keywordList: keywords, ...over });
	p.rebuildFoldTable();
	p.parseBlocklist();
	p.parseManualKeywords();
	p.parseTlds();
	return p as unknown as Internals;
}

// Types character by character the way CodeMirror would: a character the
// plugin does not take is inserted by "the editor".
function typer(keywords: string, doc = "", over: Record<string, unknown> = {}) {
	const p = plugin(keywords, over);
	const view = {
		state: EditorState.create({
			doc,
			selection: { anchor: doc.length },
			extensions: EditorState.allowMultipleSelections.of(true),
		}),
		composing: false,
		compositionStarted: false,
		dispatch(spec: TransactionSpec) {
			const tr = this.state.update(spec);
			this.state = tr.state;
			p.handleEditorUpdate(this, tr.docChanged, true, tr.changes);
		},
	};
	const type = (text: string) => {
		for (const ch of text) {
			const pos = view.state.selection.main.head;
			if (!p.handleInput(view, pos, pos, ch)) {
				view.dispatch(view.state.replaceSelection(ch));
			}
		}
		return view.state.doc.toString();
	};
	return { type, view, p };
}

test("1: addresses link only once the word is over", () => {
	const run = (keywords: string, text: string) => {
		const { type, p } = typer(keywords);
		const out = type(text);
		p.clearPendingUndo();
		return out;
	};
	assert.equal(run("", "https://www.github.com "), "[github.com](https://www.github.com) ");
	assert.equal(
		run("", "https://shop.example.com/p?id=1 "),
		"[shop.example.com/p](https://shop.example.com/p?id=1) "
	);
	assert.equal(run("", "team@mail.example.com "), "[team@mail.example.com](mailto:team@mail.example.com) ");
	// Closing punctuation before the space stays outside the link.
	assert.equal(run("", "visit https://x.com. "), "visit [x.com](https://x.com). ");
	assert.equal(run("", "(see https://x.com) "), "(see [x.com](https://x.com)) ");
	assert.equal(run("", "mail team@x.com, "), "mail [team@x.com](mailto:team@x.com), ");
});

test("1: a keyword linked on . : ? is taken back when the word goes on", () => {
	const run = (keywords: string, text: string) => {
		const { type, p } = typer(keywords);
		const out = type(text);
		p.clearPendingUndo();
		return out;
	};
	assert.equal(run("GitHub", "see github.com "), "see [github.com](https://github.com) ");
	assert.equal(run("GitHub", "https://github.com "), "[github.com](https://github.com) ");
	assert.equal(run("Node", "I use Node.js "), "I use Node.js ");
	assert.equal(run("Port", "Port:8080 "), "Port:8080 ");
	// Sentence punctuation still links, and the next sentence keeps it.
	assert.equal(run("Berlin", "in Berlin. Today "), "in [[Berlin]]. Today ");
	assert.equal(run("Berlin", "in Berlin? Yes "), "in [[Berlin]]? Yes ");
});

test("2: the bulk URL matcher stops where the address ends", () => {
	const p = plugin("Berlin");
	assert.equal(p.replaceKeywordsInText("see <https://example.com/path> ok", "", ""), "see <https://example.com/path> ok");
	assert.equal(p.replaceKeywordsInText("<team@example.com>", "", ""), "<team@example.com>");
	assert.equal(
		p.replaceKeywordsInText('"https://example.com/a" ok', "", ""),
		'"[example.com/a](https://example.com/a)" ok'
	);
	assert.equal(
		p.replaceKeywordsInText("**https://example.com/a** ok", "", ""),
		"**[example.com/a](https://example.com/a)** ok"
	);
	assert.equal(
		p.replaceKeywordsInText("https://en.wikipedia.org/wiki/Foo_(bar) x", "", ""),
		"[en.wikipedia.org/wiki/Foo_(bar)](https://en.wikipedia.org/wiki/Foo_(bar)) x"
	);
	assert.equal(
		p.replaceKeywordsInText("(see https://x.com/a)", "", ""),
		"(see [x.com/a](https://x.com/a))"
	);
});

test("3: link reference definitions keep their bare destination", () => {
	const p = plugin("Berlin");
	const defs = "[ref]: https://example.com/Berlin\n[1]: example.com\n> [q]: https://x.com\n";
	assert.equal(p.replaceKeywordsInText(defs, "", ""), defs);
	// Footnote definitions are prose.
	assert.equal(p.replaceKeywordsInText("[^1]: Berlin", "", ""), "[^1]: [[Berlin]]");
	const { type, p: t } = typer("Berlin");
	assert.equal(type("[ref]: https://x.com/Berlin "), "[ref]: https://x.com/Berlin ");
	t.clearPendingUndo();
});

test("4: nothing links inside a Markdown link that is being typed", () => {
	const run = (text: string) => {
		const { type, p } = typer("Berlin");
		const out = type(text);
		p.clearPendingUndo();
		return out;
	};
	assert.equal(
		run("[x](https://en.wikipedia.org/wiki/Berlin) "),
		"[x](https://en.wikipedia.org/wiki/Berlin) "
	);
	assert.equal(run("[x](Berlin) "), "[x](Berlin) ");
	assert.equal(run("[Berlin and more](https://a.de) "), "[Berlin and more](https://a.de) ");
	// After a closed link, linking goes on.
	assert.equal(run("[x](https://a.de) Berlin "), "[x](https://a.de) [[Berlin]] ");
});

test("5: rich-text paste and a URL pasted over a selection are left to Obsidian", () => {
	const p = plugin("Berlin");
	const make = (doc: string, anchor: number, head: number) => ({
		state: EditorState.create({ doc, selection: { anchor, head } }),
		composing: false,
		compositionStarted: false,
		dispatch(spec: TransactionSpec) {
			this.state = this.state.update(spec).state;
		},
	});
	const paste = (data: Record<string, string>) => {
		let prevented = false;
		return {
			event: {
				clipboardData: { types: Object.keys(data), getData: (k: string) => data[k] ?? "" },
				preventDefault: () => (prevented = true),
			},
			prevented: () => prevented,
		};
	};

	const html = paste({ "text/plain": "Berlin", "text/html": "<b>Berlin</b>" });
	assert.equal(p.handlePaste(html.event, make("x ", 2, 2)), false);
	assert.equal(html.prevented(), false);

	const url = paste({ "text/plain": "https://example.com" });
	assert.equal(p.handlePaste(url.event, make("some text", 0, 4)), false);

	const plain = paste({ "text/plain": "Berlin" });
	const view = make("x ", 2, 2);
	assert.equal(p.handlePaste(plain.event, view), true);
	assert.equal(view.state.doc.toString(), "x [[Berlin]]");
});

test("6: folding leaves non-Latin scripts alone", () => {
	const table = buildFoldTable({ enabled: true, lowercase: true, allLanguages: true, languages: new Set() });
	assert.notEqual(fold("ガラス", table), fold("カラス", table));
	assert.notEqual(fold("काम", table), fold("कम", table));
	assert.equal(fold("Łukasz", table), "lukasz");
	assert.equal(plugin("ガラス").replaceKeywordsInText("カラス が", "", ""), "カラス が");
	assert.equal(plugin("काम").replaceKeywordsInText("कम है", "", ""), "कम है");
	assert.equal(plugin("Łukasz").replaceKeywordsInText("Lukasz", "", ""), "[[Łukasz]]");
});

test("7: an empty alias list item does not become the keyword null", () => {
	const files = [{ path: "Tokyo.md", basename: "Tokyo", extension: "md" }];
	const p = plugin(
		"",
		{ scanVaultLinks: true },
		{
			workspace: { getActiveFile: () => null },
			vault: { getMarkdownFiles: () => files },
			metadataCache: { getFileCache: () => ({ frontmatter: { aliases: [null, "Edo", 1868] } }) },
		}
	);
	p.scanVaultLinks();
	assert.deepEqual(p.getVaultKeywords(), ["1868", "Edo", "Tokyo"]);
	assert.equal(p.replaceKeywordsInText("value is null", "", ""), "value is null");
});

test("8: no keyword is linked out of an address or a footnote label", () => {
	const off = plugin("Berlin", { urlAutolinkEnabled: false });
	assert.equal(off.replaceKeywordsInText("www.example.xyz/Berlin", "", ""), "www.example.xyz/Berlin");
	const p = plugin("Berlin");
	assert.equal(p.replaceKeywordsInText("example.xyz/Berlin", "", ""), "example.xyz/Berlin");
	assert.equal(
		p.replaceKeywordsInText("obsidian://open?vault=x&file=Berlin", "", ""),
		"obsidian://open?vault=x&file=Berlin"
	);
	assert.equal(p.replaceKeywordsInText("text[^Berlin] and Berlin", "", ""), "text[^Berlin] and [[Berlin]]");
	assert.equal(p.replaceKeywordsInText("para ^Berlin", "", ""), "para ^Berlin");
	// Plain slashes between words are no address.
	assert.equal(p.replaceKeywordsInText("Paris/Berlin", "", ""), "Paris/[[Berlin]]");

	const { type, p: t } = typer("Berlin", "", { urlAutolinkEnabled: false });
	assert.equal(type("https://x.de/Berlin "), "https://x.de/Berlin ");
	t.clearPendingUndo();
});

test("10: with several cursors the input is left to the editor", () => {
	const p = plugin("Berlin");
	const doc = "Berlin\nBerlin";
	const view = {
		state: EditorState.create({
			doc,
			selection: EditorSelection.create([EditorSelection.cursor(6), EditorSelection.cursor(13)]),
			extensions: EditorState.allowMultipleSelections.of(true),
		}),
		composing: false,
		compositionStarted: false,
		dispatch(spec: TransactionSpec) {
			this.state = this.state.update(spec).state;
		},
	};
	assert.equal(p.handleInput(view, 6, 6, " "), false);
	assert.equal(view.state.doc.toString(), doc);
	assert.equal(view.state.selection.ranges.length, 2);
});

test("12: the current-note edits touch only what changed", () => {
	const edits = (AutoLinkKeywordsPlugin as unknown as {
		lineEdits(a: string, b: string): unknown;
	}).lineEdits("a Berlin b\nsame\nBerlin", "a [[Berlin]] b\nsame\n[[Berlin]]");
	assert.deepEqual(edits, [
		{ from: { line: 0, ch: 2 }, to: { line: 0, ch: 8 }, text: "[[Berlin]]" },
		{ from: { line: 2, ch: 0 }, to: { line: 2, ch: 6 }, text: "[[Berlin]]" },
	]);
});
