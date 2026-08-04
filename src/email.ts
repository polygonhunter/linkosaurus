// Email addresses become mailto links as you type, the same way plain URLs
// become web links.
//
// Addresses also need protecting *from* the URL matcher: it scans backwards
// over URL characters, and "@" is not one of them, so "team@example.com" used
// to leave "example.com" behind as a bare domain and linked that alone. The
// callers use isEmailBoundary() to stop before an address.
//
// This module is deliberately free of any Obsidian import so it can be unit
// tested on its own.

const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;
const TRAILING_PUNCTUATION = /[.,;:!?-]/;

// A full address, anchored by the caller. The domain needs at least one dot
// and an alphabetic top-level domain; unlike bare web domains there is no
// allowlist to satisfy, because the "@" already rules out ordinary prose.
const EMAIL_RE =
	/^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

// Characters that mean the run of address-like text belongs to something
// else: an existing markdown link, a "mailto:" target, or a URL that happens
// to carry credentials (https://user@host.com/path).
const BLOCKED_BEFORE = new Set(["(", "[", "/", ":", "@", "\\", "<"]);

export function isEmailAddress(text: string): boolean {
	return EMAIL_RE.test(text);
}

// True when the character before a candidate rules it out.
function blockedBoundary(before: string): boolean {
	if (!before) return false;
	if (BLOCKED_BEFORE.has(before)) return true;
	return LOCAL_CHAR.test(before);
}

/**
 * Finds an address that ends exactly at the end of `textBefore` — the typing
 * path, where the trigger character has not been inserted yet.
 */
export function matchEmailAtEnd(
	textBefore: string
): { start: number; address: string } | null {
	if (!textBefore.length) return null;

	const at = textBefore.lastIndexOf("@");
	if (at <= 0 || at === textBefore.length - 1) return null;

	// Walk back over the local part.
	let start = at;
	while (start > 0 && LOCAL_CHAR.test(textBefore.charAt(start - 1))) start--;
	if (start === at) return null;

	if (blockedBoundary(start > 0 ? textBefore.charAt(start - 1) : "")) {
		return null;
	}

	let domainEnd = at + 1;
	while (
		domainEnd < textBefore.length &&
		DOMAIN_CHAR.test(textBefore.charAt(domainEnd))
	)
		domainEnd++;

	// Whatever follows the domain may only be the punctuation that ends a
	// sentence — anything else means the cursor is not behind an address.
	for (let i = domainEnd; i < textBefore.length; i++) {
		if (!TRAILING_PUNCTUATION.test(textBefore.charAt(i))) return null;
	}

	const address = stripTrailingPunctuation(
		textBefore.substring(start, domainEnd)
	);
	if (!isEmailAddress(address)) return null;

	return { start, address };
}

/**
 * Finds an address starting at `i` — the paste and dictation path, which
 * scans a whole block of text left to right.
 */
export function matchEmailInText(
	text: string,
	i: number,
	prevChar: string
): { address: string; end: number } | null {
	if (blockedBoundary(prevChar)) return null;
	if (!LOCAL_CHAR.test(text.charAt(i))) return null;

	let at = i;
	while (at < text.length && LOCAL_CHAR.test(text.charAt(at))) at++;
	if (at >= text.length || text.charAt(at) !== "@" || at === i) return null;

	let end = at + 1;
	while (end < text.length && DOMAIN_CHAR.test(text.charAt(end))) end++;

	let address = text.substring(i, end);
	const trimmed = stripTrailingPunctuation(address);
	end -= address.length - trimmed.length;
	address = trimmed;

	if (!isEmailAddress(address)) return null;
	return { address, end };
}

/**
 * True when the character at `pos - 1` in `text` makes the run starting at
 * `pos` the domain half of an email address. The URL matchers call this so a
 * disabled email setting still leaves addresses whole instead of linking the
 * domain out of the middle of one.
 */
export function isEmailBoundary(text: string, pos: number): boolean {
	if (pos <= 0) return false;
	if (text.charAt(pos - 1) !== "@") return false;
	// A lone "@" (a handle like "@example.com") is not an address.
	return pos >= 2 && LOCAL_CHAR.test(text.charAt(pos - 2));
}

function stripTrailingPunctuation(address: string): string {
	let out = address;
	while (out.length > 0 && TRAILING_PUNCTUATION.test(out.charAt(out.length - 1))) {
		out = out.substring(0, out.length - 1);
	}
	return out;
}

export function formatEmailAsMarkdownLink(address: string): string {
	const display = address.replace(/[\]\\]/g, "");
	const target = address.replace(/[()\s]/g, (c) => encodeURIComponent(c));
	return `[${display}](mailto:${target})`;
}
