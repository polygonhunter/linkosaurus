// Recognizers for Markdown regions the auto-linker must leave alone: tags,
// comments, math, callout headers and frontmatter. Each scanner takes the
// text and a position and returns the index just past the region it found
// there, or -1 when no such region starts at that position.
//
// Free of any Obsidian or CodeMirror import so they can be unit tested.

// Characters Obsidian accepts inside a tag (#project/sub-topic_2).
const TAG_CHAR = /[\p{L}\p{N}\p{M}_\-/]/u;

/** Letters, digits and combining marks: what counts as part of a word. */
export const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

export function isWordChar(ch: string): boolean {
	return !!ch && WORD_CHAR.test(ch);
}

/**
 * A #tag starting at `i`. `prevChar` is the character before `i` (empty at
 * the start of the text); a tag only starts after whitespace or at the start,
 * so "C#" or "page#anchor" are not tags. "# Heading" is not a tag either.
 */
export function skipHashtag(text: string, i: number, prevChar: string): number {
	if (text.charAt(i) !== "#") return -1;
	if (prevChar && !/\s/.test(prevChar)) return -1;
	let end = i + 1;
	while (end < text.length && TAG_CHAR.test(text.charAt(end))) end++;
	return end > i + 1 ? end : -1;
}

/**
 * True when the text ends inside a #tag token, i.e. a keyword starting right
 * after `before` would be part of a tag ("#Ber" + "lin" → no link).
 */
export function endsInHashtag(before: string): boolean {
	let j = before.length;
	while (j > 0 && TAG_CHAR.test(before.charAt(j - 1))) j--;
	if (j === 0 || before.charAt(j - 1) !== "#") return false;
	const prev = j >= 2 ? before.charAt(j - 2) : "";
	return !prev || /\s/.test(prev);
}

/**
 * An Obsidian comment %%…%% starting at `i`. Like Obsidian, an unclosed
 * comment runs to the end of the text.
 */
export function skipComment(text: string, i: number): number {
	if (text.substring(i, i + 2) !== "%%") return -1;
	const close = text.indexOf("%%", i + 2);
	return close === -1 ? text.length : close + 2;
}

/** A display-math block $$…$$ starting at `i`; unclosed is not math. */
export function skipDisplayMath(text: string, i: number): number {
	if (text.substring(i, i + 2) !== "$$") return -1;
	const close = text.indexOf("$$", i + 2);
	return close === -1 ? -1 : close + 2;
}

/**
 * Inline math $…$ starting at `i`, on a single line. Follows the Markdown
 * convention that keeps prices from turning into math: the opening $ is not
 * followed by whitespace, the closing $ is not preceded by whitespace and not
 * followed by a digit.
 */
export function skipInlineMath(text: string, i: number): number {
	if (text.charAt(i) !== "$") return -1;
	const first = text.charAt(i + 1);
	if (!first || first === "$" || /\s/.test(first)) return -1;
	for (let j = i + 1; j < text.length; j++) {
		const ch = text.charAt(j);
		if (ch === "\n") return -1;
		if (ch === "\\") {
			j++;
			continue;
		}
		if (ch !== "$") continue;
		if (/\s/.test(text.charAt(j - 1))) continue;
		if (/[0-9]/.test(text.charAt(j + 1))) continue;
		return j + 1;
	}
	return -1;
}

/** A callout header [!type] (optionally with +/- fold marker) at `i`. */
export function skipCalloutType(text: string, i: number): number {
	if (text.substring(i, i + 2) !== "[!") return -1;
	const m = /^\[![^\]\n]+\][+-]?/.exec(text.substring(i, i + 64));
	return m ? i + m[0].length : -1;
}

/**
 * The line number (1-based) of the closing fence of a YAML frontmatter
 * block, or -1 when the document has none. `line(n)` returns line n.
 * Only the first `maxLines` lines are searched.
 */
export function frontmatterCloseLine(
	line: (n: number) => string,
	lineCount: number,
	maxLines = 2000
): number {
	if (lineCount < 2 || !/^---[ \t]*$/.test(line(1))) return -1;
	const last = Math.min(lineCount, maxLines);
	for (let n = 2; n <= last; n++) {
		if (/^(---|\.\.\.)[ \t]*$/.test(line(n))) return n;
	}
	return -1;
}

/**
 * Index just past the frontmatter block at the start of `text`, or 0 when
 * there is none.
 */
export function frontmatterEnd(text: string): number {
	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return 0;
	const searchFrom = text.indexOf("\n") + 1;
	const match = /(^|\n)---[ \t]*(?:\r?\n|$)/.exec(text.substring(searchFrom));
	if (!match) return 0;
	return searchFrom + match.index + match[0].length;
}

/**
 * True when only indentation (or blockquote markers) stands between the
 * start of the line and `i`. `charBefore` is the character before the text,
 * for text that is inserted into a document.
 */
export function isAtLineStart(text: string, i: number, charBefore = ""): boolean {
	let j = i - 1;
	while (j >= 0 && /[ \t>]/.test(text.charAt(j))) j--;
	if (j >= 0) return text.charAt(j) === "\n";
	return charBefore === "" || charBefore === "\n";
}

/**
 * Like isAtLineStart, but a fence may also follow list markers: "- ```" or
 * "1. ```" opens a code block inside a list item.
 */
function isAtFenceStart(text: string, i: number, charBefore: string): boolean {
	const lineStart = text.lastIndexOf("\n", i - 1) + 1;
	if (lineStart === 0 && charBefore !== "" && charBefore !== "\n") return false;
	const prefix = text.substring(lineStart, i);
	return /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+[ \t>]*)*$/.test(prefix);
}

/**
 * A fenced code block (``` or ~~~, three or more) starting at `i`. Fences
 * only open at the start of a line; the block ends at a line that starts
 * with at least as many of the same character, or runs to the end of the
 * text when it is never closed.
 */
export function skipFencedCode(text: string, i: number, charBefore = ""): number {
	const ch = text.charAt(i);
	if (ch !== "`" && ch !== "~") return -1;
	let n = i;
	while (n < text.length && text.charAt(n) === ch) n++;
	const len = n - i;
	if (len < 3) return -1;
	if (!isAtFenceStart(text, i, charBefore)) return -1;
	// Backtick fences cannot carry a backtick in their info string.
	const lineEnd = text.indexOf("\n", n);
	const info = text.substring(n, lineEnd === -1 ? text.length : lineEnd);
	if (ch === "`" && info.includes("`")) return -1;
	if (lineEnd === -1) return text.length;

	let pos = lineEnd + 1;
	while (pos <= text.length) {
		const next = text.indexOf("\n", pos);
		const line = text.substring(pos, next === -1 ? text.length : next);
		const m = /^[ \t>]*([`~]+)[ \t]*$/.exec(line);
		if (m && m[1]!.charAt(0) === ch && m[1]!.length >= len && !m[1]!.includes(ch === "`" ? "~" : "`")) {
			return next === -1 ? text.length : next;
		}
		if (next === -1) break;
		pos = next + 1;
	}
	return text.length;
}

/**
 * Inline code starting at `i`: a run of backticks closed by a run of the
 * same length within the same paragraph. Returns -1 when there is no such
 * closer, so a stray backtick does not swallow the rest of the note.
 */
export function skipInlineCode(text: string, i: number): number {
	if (text.charAt(i) !== "`") return -1;
	let n = i;
	while (n < text.length && text.charAt(n) === "`") n++;
	const len = n - i;
	const paragraphEnd = text.indexOf("\n\n", n);
	const limit = paragraphEnd === -1 ? text.length : paragraphEnd;
	let j = n;
	while (j < limit) {
		const k = text.indexOf("`", j);
		if (k === -1 || k >= limit) return -1;
		let e = k;
		while (e < text.length && text.charAt(e) === "`") e++;
		if (e - k === len) return e;
		j = e;
	}
	return -1;
}

// Block-level HTML elements: a line starting with one of these opens an
// HTML block that runs to the next blank line (CommonMark rule 6), and
// Markdown inside it is not rendered.
const HTML_BLOCK_TAGS = new Set(
	(
		"address article aside blockquote body caption center col colgroup dd " +
		"details dialog dir div dl dt fieldset figcaption figure footer form " +
		"h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu " +
		"nav ol p pre script section source style summary table tbody td " +
		"textarea tfoot th thead title tr ul video audio canvas svg"
	).split(" ")
);

/**
 * HTML starting at `i`: a comment <!-- … --> (unclosed runs to the end of
 * the text), an HTML block opened by a block-level tag at the start of a
 * line (runs to the next blank line), or a single inline tag with its
 * attributes. Returns -1 when no HTML starts there, so "a < b" or "<3"
 * stay ordinary text.
 */
export function skipHtml(text: string, i: number, charBefore = ""): number {
	if (text.charAt(i) !== "<") return -1;
	if (text.startsWith("<!--", i)) {
		const close = text.indexOf("-->", i + 4);
		return close === -1 ? text.length : close + 3;
	}
	const m = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:[ \t\n][^<>]*)?\/?>/.exec(
		text.substring(i, i + 2000)
	);
	if (!m) return -1;
	const tagEnd = i + m[0].length;
	if (
		HTML_BLOCK_TAGS.has(m[2]!.toLowerCase()) &&
		isAtLineStart(text, i, charBefore)
	) {
		const blank = /\n[ \t]*(?:\n|$)/.exec(text.substring(tagEnd));
		return blank ? tagEnd + blank.index : text.length;
	}
	return tagEnd;
}

/**
 * An autolink <https://…> or <name@host> starting at `i`. Its content is
 * already a link; wrapping it in another one breaks both.
 */
export function skipAutolink(text: string, i: number): number {
	if (text.charAt(i) !== "<") return -1;
	const m =
		/^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/.exec(
			text.substring(i, i + 2000)
		);
	return m ? i + m[0].length : -1;
}

// A link reference definition, "[label]: https://…" — its target must stay
// a bare destination or every [text][label] using it breaks. Footnote
// definitions ("[^1]: …") hold prose and are not matched.
const REFERENCE_DEFINITION = /^[ \t>]*\[(?!\^)[^\]\n]+\]:(?:[ \t]|$)/;

/** True when a line (or the start of one) is a link reference definition. */
export function isReferenceDefinition(lineText: string): boolean {
	return REFERENCE_DEFINITION.test(lineText);
}

/**
 * A link reference definition starting at `i` (its "["): returns the end of
 * its line, which is left as it is.
 */
export function skipReferenceDefinition(
	text: string,
	i: number,
	charBefore = ""
): number {
	if (text.charAt(i) !== "[" || !isAtLineStart(text, i, charBefore)) return -1;
	const lineEnd = text.indexOf("\n", i);
	const line = text.substring(i, lineEnd === -1 ? text.length : lineEnd);
	if (!isReferenceDefinition(line)) return -1;
	return lineEnd === -1 ? text.length : lineEnd;
}

// "scheme://…" or "domain.tld/…": text that is part of an address, whether
// or not it is linked as one.
const URL_LIKE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?:www\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\/)/;

/**
 * A URL-like run starting at `i` that was not turned into a link (URL
 * linking off, or a top-level domain not on the list). Returns its end, so
 * no keyword is linked out of the middle of an address.
 */
export function skipUrlLike(text: string, i: number): number {
	if (!URL_LIKE.test(text.substring(i, i + 300))) return -1;
	let end = i;
	while (end < text.length && !/[\s<>"`[\]]/.test(text.charAt(end))) end++;
	return end;
}

/**
 * True when the text before the cursor ends inside a URL-like run, so a
 * keyword typed there belongs to the address ("https://x.de/Berlin").
 */
export function endsInUrl(textBefore: string): boolean {
	const token = /[^\s<>"`[\]()]*$/.exec(textBefore)?.[0] ?? "";
	return token.includes("://") || URL_LIKE.test(token);
}
