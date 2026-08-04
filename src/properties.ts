// Property values are plain text in Obsidian's property editor, and that
// editor is not the markdown editor — plugins never see the keystrokes, so
// none of the typing machinery reaches it. What we can do is match a value
// once it has been committed to the file.
//
// Two rules keep this safe:
//
//   1. Whole values only. "author: Tokyo" links; "description: Trip to
//      Tokyo" does not. Property fields hold one thing, prose does not, and
//      rewriting prose from the outside would be a surprise.
//   2. Never touch Obsidian's own fields. Wikilinks are invalid in tags and
//      meaningless in aliases and cssclasses.
//
// This module is deliberately free of any Obsidian import so it can be unit
// tested on its own.

export const RESERVED_PROPERTIES = new Set([
	"tags",
	"tag",
	"aliases",
	"alias",
	"cssclasses",
	"cssclass",
]);

export interface PropertyCandidate {
	/** What the user typed, e.g. "Museum". */
	keyword: string;
	/** The note it should point at, e.g. "Museum of Natural History". */
	target: string;
}

export interface PropertyMatcher {
	/** Exact keyword, alias or note-name lookup. Returns the link target. */
	lookup: (value: string) => string | undefined;
	/** Note names and aliases that begin with the value, for prefix matching. */
	prefixCandidates: (value: string) => string[];
	/** Note name of the file being edited, so it never links to itself. */
	selfName: string;
	/** Case and accent folding, shared with the rest of the plugin. */
	foldKey: (text: string) => string;
	/**
	 * Case folding only. Two notes that differ just by accent are still two
	 * notes, so telling them apart needs a key that keeps the accents.
	 */
	exactKey: (text: string) => string;
	prefixMatchEnabled: boolean;
}

/** Current settings schema. Raise this when defaults must reach existing vaults. */
export const SETTINGS_VERSION = 1;

/**
 * Property linking shipped switched off in 4.3.0 and never worked there or in
 * 4.3.1, and stored settings win over new defaults — so every vault that
 * tried it would stay switched off forever. Settings written before this
 * schema existed therefore get the property options put back to their
 * defaults, once. A choice made from 4.3.2 on carries the marker and stands.
 */
export function migratePropertySettings(stored: {
	version: unknown;
	enabled: boolean;
	fields: string;
}): { version: number; enabled: boolean; fields: string } {
	const version = typeof stored.version === "number" ? stored.version : 0;
	if (version >= SETTINGS_VERSION) {
		return {
			version,
			enabled: stored.enabled,
			fields: stored.fields,
		};
	}
	return { version: SETTINGS_VERSION, enabled: true, fields: "" };
}

/**
 * What to do when a property change has settled. Pending work is never
 * dropped: while a property field still holds focus the value may still be
 * mid-edit, so the decision is to wait and ask again — the 4.3.0 bug was
 * returning here and losing the work for good.
 */
export function nextPropertyLinkAction(state: {
	focusInProperties: boolean;
}): "link" | "wait" {
	return state.focusInProperties ? "wait" : "link";
}

/**
 * Finds the note-search trigger inside a property field's value. Obsidian's
 * property editor is not the markdown editor, so the popup there is driven by
 * the whole field value rather than by cursor position: everything after the
 * last trigger is the search, spaces included.
 */
export function matchPropertySearchTrigger(
	value: string,
	trigger: string
): { query: string } | null {
	if (!trigger) return null;
	const idx = value.lastIndexOf(trigger);
	if (idx === -1) return null;

	const before = idx > 0 ? value.charAt(idx - 1) : "";
	if (/[\p{L}\p{N}]/u.test(before)) return null;
	if (before === trigger.charAt(0)) return null;

	const query = value.substring(idx + trigger.length);
	if (/^\s/.test(query)) return null;
	if (query.includes("[[")) return null;

	return { query };
}

/**
 * True for the editable element inside a property's value cell. Obsidian's
 * property markup is not part of the public API, so this stays a plain
 * structural test: no match simply means no popup.
 */
export function isPropertyValueField(el: {
	isContentEditable?: boolean;
	tagName?: string;
	getAttribute?: (name: string) => string | null;
	closest?: (selector: string) => unknown;
}): boolean {
	if (!el.closest?.(".metadata-property-value")) return false;
	if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
	if (el.isContentEditable) return true;
	return el.getAttribute?.("contenteditable") === "true";
}

/** The finished value a picked suggestion writes into the property. */
export function propertyLinkFromEntry(
	keyword: string,
	target: string,
	foldKey: (text: string) => string
): string {
	return foldKey(keyword) === foldKey(target)
		? `[[${target}]]`
		: `[[${target}|${keyword}]]`;
}

export function parsePropertyList(raw: string): string[] {
	const out: string[] = [];
	for (const line of raw.split("\n")) {
		const name = line.trim().toLowerCase();
		if (name && !out.includes(name)) out.push(name);
	}
	return out;
}

export function isLinkableProperty(name: string, allowed: string[]): boolean {
	const key = name.trim().toLowerCase();
	if (RESERVED_PROPERTIES.has(key)) return false;
	// An empty list means every property except the reserved ones.
	return allowed.length === 0 || allowed.includes(key);
}

/**
 * Decides what a single property value should become. Returns null when the
 * value should stay exactly as it is.
 */
export function linkPropertyValue(
	value: unknown,
	matcher: PropertyMatcher
): string | null {
	if (typeof value !== "string") return null;

	const text = value.trim();
	if (!text) return null;
	// Already a link, or something that only looks like one.
	if (text.includes("[[") || text.includes("](")) return null;
	// Values carrying markup or line breaks are not plain names.
	if (/[\n\r|#^]/.test(text)) return null;

	const resolved = resolveTarget(text, matcher);
	if (!resolved) return null;
	const { target, viaPrefix } = resolved;
	if (matcher.foldKey(target) === matcher.foldKey(matcher.selfName)) {
		return null;
	}

	// A prefix hit means the typed text was an abbreviation of the real name,
	// so the property gets the full name — the same result as picking the
	// note from Obsidian's own [[ menu. Everything else follows the typing
	// path: keep what was typed as display text unless it already matches the
	// note (accents included, where the note's spelling wins).
	if (viaPrefix) return `[[${target}]]`;
	return matcher.foldKey(target) === matcher.foldKey(text)
		? `[[${target}]]`
		: `[[${target}|${text}]]`;
}

function resolveTarget(
	text: string,
	matcher: PropertyMatcher
): { target: string; viaPrefix: boolean } | undefined {
	const exact = matcher.lookup(text);
	if (exact) return { target: exact, viaPrefix: false };

	if (!matcher.prefixMatchEnabled) return undefined;

	// "Museum" should find "Museum of Natural History" — but only when there is
	// exactly one candidate. Two notes starting the same way is a coin flip,
	// and a coin flip has no place rewriting someone's file. Candidates are
	// counted by their exact spelling, so Zürich and Zurich count as two.
	const candidates = matcher.prefixCandidates(text);
	const unique = new Set(candidates.map((c) => matcher.exactKey(c)));
	if (unique.size !== 1) return undefined;
	const target = candidates[0];
	return target ? { target, viaPrefix: true } : undefined;
}

/**
 * Applies linkPropertyValue across a frontmatter object. Returns the changed
 * keys with their new values; an empty map means nothing needs writing.
 */
export function linkFrontmatter(
	frontmatter: Record<string, unknown>,
	allowed: string[],
	matcher: PropertyMatcher
): Map<string, string | string[]> {
	const changes = new Map<string, string | string[]>();

	for (const [name, value] of Object.entries(frontmatter)) {
		if (!isLinkableProperty(name, allowed)) continue;

		if (Array.isArray(value)) {
			let touched = false;
			const next = value.map((item) => {
				const linked = linkPropertyValue(item, matcher);
				if (linked === null) return item as unknown;
				touched = true;
				return linked;
			});
			if (touched) changes.set(name, next as string[]);
			continue;
		}

		const linked = linkPropertyValue(value, matcher);
		if (linked !== null) changes.set(name, linked);
	}

	return changes;
}
