// Cross-language matching: folds accented and special letters to a plain
// base form so a note named "Łukasz Nowak" can be reached by typing
// "Lukasz Nowak".
//
// Two things make this less trivial than a NFD-and-strip-marks one-liner:
//
//   1. Some letters do not decompose at all — ł, ø, đ, ı carry no combining
//      mark, so stripping marks leaves them untouched. They need an explicit
//      table.
//   2. Some folds change length — ß→ss, æ→ae, þ→th. The callers use string
//      offsets to build document edits, so every fold ships an index map back
//      to the source text.
//
// This module is deliberately free of any Obsidian import so it can be unit
// tested on its own.

const MARK = /\p{M}/u;
const MARK_G = /\p{M}/gu;
const ASCII_ONLY = /^\p{ASCII}*$/u;

// Letters with no canonical decomposition: stripping combining marks does
// nothing for these, so they are spelled out.
const ONE_TO_ONE = new Map<string, string>([
	["ł", "l"],
	["ø", "o"],
	["đ", "d"],
	["ð", "d"],
	["ħ", "h"],
	["ı", "i"],
	["ŧ", "t"],
	["ŋ", "n"],
	["ĸ", "k"],
	["ƀ", "b"],
	["ɨ", "i"],
	["ə", "e"],
	["ŀ", "l"],
]);

// Folds that change length. These are why the index maps exist.
const ONE_TO_N = new Map<string, string>([
	["ß", "ss"],
	["æ", "ae"],
	["œ", "oe"],
	["þ", "th"],
	["ĳ", "ij"],
	["ŉ", "n"],
]);

export interface LanguagePack {
	id: string;
	label: string;
	/** Shown in settings so the user can see what the pack covers. */
	sample: string;
	/** Characters this pack claims, lowercase. Only consulted in "selected" mode. */
	chars: string[];
	/**
	 * Extra spellings beyond the canonical fold, for the cases where languages
	 * genuinely disagree: German ü is both "u" and "ue", Danish ø is both "o"
	 * and "oe". Keys are lowercase.
	 */
	alternates?: Record<string, string[]>;
}

// Vietnamese letters are the base vowels crossed with five tone marks — 60+
// precomposed characters. Generating them beats listing them.
function vietnameseChars(): string[] {
	const bases = "aăâeêioôơuưy";
	const tones = ["", "̀", "́", "̃", "̉", "̣"];
	const out = ["đ"];
	for (const base of bases) {
		for (const tone of tones) {
			out.push((base + tone).normalize("NFC"));
		}
	}
	return out;
}

function chars(source: string): string[] {
	return [...source].filter((c) => c.trim().length > 0);
}

export const LANGUAGE_PACKS: LanguagePack[] = [
	{
		id: "pl",
		label: "Polish",
		sample: "ł ą ę ś ż ź ć ń ó",
		chars: chars("łąęśżźćńó"),
	},
	{
		id: "cs",
		label: "Czech & Slovak",
		sample: "ř š č ž ě ď ť ň ů ĺ ľ ŕ",
		chars: chars("řščžěďťňůáéíóúýĺľŕäô"),
	},
	{
		id: "tr",
		label: "Turkish",
		sample: "ş ğ ı İ ç ö ü",
		// "i̇" is what İ lowercases to — dotted capital I has no
		// precomposed lowercase form.
		chars: [...chars("şğıçöü"), "i̇"],
	},
	{
		id: "de",
		label: "German",
		sample: "ä ö ü ß  →  also ae oe ue ss",
		chars: chars("äöüß"),
		alternates: { "ä": ["ae"], "ö": ["oe"], "ü": ["ue"] },
	},
	{
		id: "scandi",
		label: "Danish, Norwegian & Swedish",
		sample: "ø æ å ä ö  →  also oe ae aa",
		chars: chars("øæåäö"),
		alternates: { "ø": ["oe"], "å": ["aa"] },
	},
	{
		id: "is",
		label: "Icelandic & Faroese",
		sample: "þ ð æ ö á é í ó ú ý",
		chars: chars("þðæöáéíóúý"),
		alternates: { "ð": ["dh"] },
	},
	{
		id: "fr",
		label: "French",
		sample: "é è ê ë à â ç î ï ô ù û ü ÿ œ",
		chars: chars("éèêëàâçîïôùûüÿœæ"),
	},
	{
		id: "es",
		label: "Spanish, Portuguese & Catalan",
		sample: "ñ á é í ó ú ü ã õ â ê ô à ç",
		chars: chars("ñáéíóúüãõâêôàòçï"),
	},
	{
		id: "hu",
		label: "Hungarian",
		sample: "ő ű á é í ó ö ú ü",
		chars: chars("őűáéíóöúü"),
	},
	{
		id: "ro",
		label: "Romanian",
		sample: "ă â î ș ț",
		chars: chars("ăâîșțşţ"),
	},
	{
		id: "balt",
		label: "Lithuanian, Latvian & Estonian",
		sample: "ą č ę ė į š ų ū ž ā ē ģ ī ķ ļ ņ ŗ õ",
		chars: chars("ąčęėįšųūžāēģīķļņōŗõäöüšž"),
	},
	{
		id: "hr",
		label: "Croatian, Serbian & Bosnian",
		sample: "č ć đ š ž",
		chars: chars("čćđšž"),
	},
	{
		id: "vi",
		label: "Vietnamese",
		sample: "ă â đ ê ô ơ ư + tone marks",
		chars: vietnameseChars(),
	},
];

export const LANGUAGE_PACK_IDS = LANGUAGE_PACKS.map((p) => p.id);
export const DEFAULT_LANGUAGES = LANGUAGE_PACK_IDS.join(",");

/** Upper bound on folded spellings generated per keyword. */
export const VARIANT_CAP = 8;

export interface FoldTable {
	enabled: boolean;
	lowercase: boolean;
	/** null means "fold everything"; a set restricts folding to those characters. */
	allow: Set<string> | null;
	alternates: Map<string, string[]>;
}

export function parseLanguages(value: string): Set<string> {
	const known = new Set(LANGUAGE_PACK_IDS);
	const out = new Set<string>();
	for (const raw of value.split(/[,\n]/)) {
		const id = raw.trim();
		if (id && known.has(id)) out.add(id);
	}
	return out;
}

export function buildFoldTable(opts: {
	enabled: boolean;
	lowercase: boolean;
	allLanguages: boolean;
	languages: Set<string>;
}): FoldTable {
	const alternates = new Map<string, string[]>();
	let allow: Set<string> | null = null;

	if (!opts.allLanguages) allow = new Set<string>();

	for (const pack of LANGUAGE_PACKS) {
		if (!opts.allLanguages && !opts.languages.has(pack.id)) continue;
		if (allow) for (const ch of pack.chars) allow.add(ch);
		if (!pack.alternates) continue;
		for (const [ch, spellings] of Object.entries(pack.alternates)) {
			const existing = alternates.get(ch);
			if (existing) {
				for (const s of spellings) {
					if (!existing.includes(s)) existing.push(s);
				}
			} else {
				alternates.set(ch, [...spellings]);
			}
		}
	}

	return { enabled: opts.enabled, lowercase: opts.lowercase, allow, alternates };
}

interface Cluster {
	start: number;
	end: number;
	/** The base character plus any trailing combining marks, composed to NFC. */
	composed: string;
}

// Splits text into base-character-plus-marks clusters so that precomposed
// ("é") and decomposed ("e" + U+0301) input fold identically — macOS hands
// out decomposed file names, Windows and Linux precomposed ones.
function clusters(text: string): Cluster[] {
	const out: Cluster[] = [];
	let i = 0;
	while (i < text.length) {
		let ch = String.fromCodePoint(text.codePointAt(i)!);
		let j = i + ch.length;
		while (j < text.length) {
			const next = String.fromCodePoint(text.codePointAt(j)!);
			if (!MARK.test(next)) break;
			ch += next;
			j += next.length;
		}
		out.push({ start: i, end: j, composed: ch.normalize("NFC") });
		i = j;
	}
	return out;
}

function titleCase(text: string): string {
	return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function foldKey(composed: string): string {
	return composed.toLowerCase().normalize("NFC");
}

function baseFold(key: string): string {
	const direct = ONE_TO_N.get(key) ?? ONE_TO_ONE.get(key);
	if (direct !== undefined) return direct;

	// Accented forms of the special letters ("ǽ") decompose down to the
	// special letter itself, so run the tables again over what's left.
	const stripped = key.normalize("NFD").replace(MARK_G, "");
	let out = "";
	for (const ch of stripped) {
		out += ONE_TO_N.get(ch) ?? ONE_TO_ONE.get(ch) ?? ch;
	}
	return out;
}

function foldCluster(cluster: Cluster, table: FoldTable, raw: string): string {
	if (!table.enabled) return table.lowercase ? raw.toLowerCase() : raw;

	const key = foldKey(cluster.composed);
	if (table.allow && !table.allow.has(key)) {
		return table.lowercase ? raw.toLowerCase() : raw;
	}

	const folded = baseFold(key);
	if (table.lowercase) return folded;
	return cluster.composed === key ? folded : titleCase(folded);
}

export interface FoldedText {
	folded: string;
	/**
	 * toSrc[i] is the source index of the character that produced folded[i].
	 * Length is folded.length + 1; the final entry is text.length.
	 * null means the fold was length-preserving, so folded and source indices
	 * are the same — the overwhelmingly common case, and worth not allocating
	 * two arrays per keystroke for.
	 */
	toSrc: number[] | null;
	/**
	 * toFolded[j] is the folded index at which source character j starts.
	 * Length is text.length + 1. null means identity, as above.
	 */
	toFolded: number[] | null;
}

/** Fast path: plain ASCII never folds and never changes length. */
function isAscii(text: string): boolean {
	return ASCII_ONLY.test(text);
}

/**
 * Whether the per-cluster walk is needed, or a plain toLowerCase() will do.
 *
 * Even with folding off, lowercasing is not always length-preserving — the
 * Turkish dotted capital İ becomes "i" plus a combining dot, two characters
 * from one. Callers index raw text with these offsets, so those strings need
 * a real index map rather than an assumed identity.
 */
function needsWalk(text: string, table: FoldTable): boolean {
	if (isAscii(text)) return false;
	if (table.enabled) return true;
	if (!table.lowercase) return false;
	return text.toLowerCase().length !== text.length;
}

export function toSrcIndex(f: FoldedText, foldedIndex: number): number {
	return f.toSrc ? f.toSrc[foldedIndex]! : foldedIndex;
}

export function toFoldedIndex(f: FoldedText, srcIndex: number): number {
	return f.toFolded ? f.toFolded[srcIndex]! : srcIndex;
}

/**
 * Whether a folded index sits on a source-character boundary rather than
 * inside an expansion.
 *
 * "Meßner" folds to "messner"; without this check a keyword folding to "sner"
 * would match at folded index 3 — the middle of the ß — and the replacement
 * would eat half a character.
 */
export function isFoldBoundary(f: FoldedText, foldedIndex: number): boolean {
	if (!f.toSrc || foldedIndex <= 0 || foldedIndex >= f.folded.length) {
		return true;
	}
	return f.toSrc[foldedIndex] !== f.toSrc[foldedIndex - 1];
}

export function fold(text: string, table: FoldTable): string {
	if (!needsWalk(text, table)) {
		return table.lowercase ? text.toLowerCase() : text;
	}
	let out = "";
	for (const cluster of clusters(text)) {
		out += foldCluster(cluster, table, text.slice(cluster.start, cluster.end));
	}
	return out;
}

export function foldWithMap(text: string, table: FoldTable): FoldedText {
	if (!needsWalk(text, table)) {
		return {
			folded: table.lowercase ? text.toLowerCase() : text,
			toSrc: null,
			toFolded: null,
		};
	}

	let folded = "";
	let toSrc: number[] | null = null;
	let toFolded: number[] | null = null;

	for (const cluster of clusters(text)) {
		const width = cluster.end - cluster.start;
		const piece = foldCluster(
			cluster,
			table,
			text.slice(cluster.start, cluster.end)
		);

		// Stay on the identity path until a cluster actually changes width,
		// then backfill the maps for everything seen so far.
		if (toSrc === null && piece.length !== width) {
			toSrc = [];
			toFolded = [];
			for (let k = 0; k < folded.length; k++) toSrc.push(k);
			for (let k = 0; k < cluster.start; k++) toFolded.push(k);
		}

		if (toSrc !== null && toFolded !== null) {
			for (let k = 0; k < width; k++) toFolded.push(folded.length);
			for (let k = 0; k < piece.length; k++) toSrc.push(cluster.start);
		}

		folded += piece;
	}

	if (toSrc !== null && toFolded !== null) {
		toSrc.push(text.length);
		toFolded.push(folded.length);
	}

	return { folded, toSrc, toFolded };
}

/**
 * Every folded spelling a keyword should answer to, canonical form first.
 *
 * "Søren" yields ["soren", "soeren"] with the Scandinavian pack on, so both
 * ways of typing it around a missing ø find the note.
 */
export function foldVariants(text: string, table: FoldTable): string[] {
	const canonical = fold(text, table);
	if (!table.enabled || table.alternates.size === 0 || isAscii(text)) {
		return canonical ? [canonical] : [];
	}

	let variants: string[] = [""];
	for (const cluster of clusters(text)) {
		const raw = text.slice(cluster.start, cluster.end);
		const canon = foldCluster(cluster, table, raw);
		const key = foldKey(cluster.composed);
		const allowed = !table.allow || table.allow.has(key);
		const alts = allowed ? table.alternates.get(key) : undefined;

		if (!alts || alts.length === 0 || variants.length * (alts.length + 1) > VARIANT_CAP) {
			for (let k = 0; k < variants.length; k++) variants[k] += canon;
			continue;
		}

		const upper = !table.lowercase && cluster.composed !== key;
		const options = [canon, ...alts.map((a) => (upper ? titleCase(a) : a))];
		const next: string[] = [];
		for (const prefix of variants) {
			for (const option of options) next.push(prefix + option);
		}
		variants = next;
	}

	const seen = new Set<string>();
	const out: string[] = [];
	if (canonical) {
		seen.add(canonical);
		out.push(canonical);
	}
	for (const variant of variants) {
		if (!variant || seen.has(variant)) continue;
		seen.add(variant);
		out.push(variant);
	}
	return out;
}
