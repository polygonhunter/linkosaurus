import test from "node:test";
import assert from "node:assert/strict";
import {
	isLinkableProperty,
	linkFrontmatter,
	linkPropertyValue,
	parsePropertyList,
	type PropertyMatcher,
} from "../src/properties";

const NOTES = ["Tokyo", "Ocean Service Group", "Machine Learning", "Łukasz Nowak"];
const MAPPINGS = new Map([["ml", "Machine Learning"]]);

function foldKey(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.replace(/ł/g, "l");
}

function matcher(over: Partial<PropertyMatcher> = {}): PropertyMatcher {
	return {
		lookup: (value) => {
			const key = foldKey(value);
			const note = NOTES.find((n) => foldKey(n) === key);
			if (note) return note;
			return MAPPINGS.get(key);
		},
		prefixCandidates: (value) => {
			const key = foldKey(value);
			return NOTES.filter((n) => foldKey(n).startsWith(key));
		},
		selfName: "Sourcename",
		foldKey,
		exactKey: (text) => text.toLowerCase(),
		prefixMatchEnabled: true,
		...over,
	};
}

test("links an exact note name", () => {
	assert.equal(linkPropertyValue("Tokyo", matcher()), "[[Tokyo]]");
});

test("keeps the typed word as display text for mappings", () => {
	assert.equal(
		linkPropertyValue("ML", matcher()),
		"[[Machine Learning|ML]]"
	);
});

test("resolves an unambiguous prefix — the Ocean case", () => {
	// A prefix hit writes the full note name, like picking it from Obsidian's
	// own [[ menu would.
	assert.equal(
		linkPropertyValue("Ocean", matcher()),
		"[[Ocean Service Group]]"
	);
});

test("refuses an ambiguous prefix", () => {
	const twoOceans = matcher({
		prefixCandidates: () => ["Ocean Service Group", "Ocean Freight"],
	});
	assert.equal(linkPropertyValue("Ocean", twoOceans), null);
});

test("two notes differing only by accent are not a unique prefix", () => {
	const bothZurichs = matcher({
		prefixCandidates: () => ["Zürich", "Zurich"],
	});
	assert.equal(linkPropertyValue("Zur", bothZurichs), null);
});

test("prefix matching can be switched off", () => {
	assert.equal(
		linkPropertyValue("Ocean", matcher({ prefixMatchEnabled: false })),
		null
	);
});

test("matches across accents and keeps the note's spelling", () => {
	assert.equal(
		linkPropertyValue("Lukasz Nowak", matcher()),
		"[[Łukasz Nowak]]"
	);
});

test("leaves values that are already links", () => {
	assert.equal(linkPropertyValue("[[Tokyo]]", matcher()), null);
	assert.equal(
		linkPropertyValue("[Tokyo](https://example.com)", matcher()),
		null
	);
});

test("leaves values that match nothing", () => {
	assert.equal(linkPropertyValue("Some free text", matcher()), null);
	assert.equal(linkPropertyValue("", matcher()), null);
	assert.equal(linkPropertyValue("   ", matcher()), null);
});

test("ignores non-text values", () => {
	assert.equal(linkPropertyValue(42, matcher()), null);
	assert.equal(linkPropertyValue(true, matcher()), null);
	assert.equal(linkPropertyValue(null, matcher()), null);
	assert.equal(linkPropertyValue(undefined, matcher()), null);
});

test("never links a note to itself", () => {
	assert.equal(
		linkPropertyValue("Sourcename", matcher({ selfName: "Sourcename" })),
		null
	);
});

test("skips values carrying wikilink-breaking characters", () => {
	assert.equal(linkPropertyValue("Tokyo|x", matcher()), null);
	assert.equal(linkPropertyValue("Tokyo\nBerlin", matcher()), null);
});

test("reserved properties stay untouched", () => {
	assert.ok(!isLinkableProperty("tags", []));
	assert.ok(!isLinkableProperty("Aliases", []));
	assert.ok(!isLinkableProperty("cssclasses", []));
	assert.ok(isLinkableProperty("author", []));
});

test("an explicit list narrows which properties are touched", () => {
	assert.ok(isLinkableProperty("author", ["author", "publisher"]));
	assert.ok(!isLinkableProperty("status", ["author", "publisher"]));
	assert.ok(!isLinkableProperty("tags", ["tags"]));
});

test("parses the settings list", () => {
	assert.deepEqual(
		parsePropertyList("author\n Publisher \n\nauthor\n"),
		["author", "publisher"]
	);
});

test("walks a whole frontmatter block", () => {
	const fm = {
		author: "Ocean",
		publisher: "Tokyo",
		status: "Some free text",
		tags: "Tokyo",
		published: "2026-08-04",
		related: ["Tokyo", "nothing here", "[[Berlin]]"],
	};
	const changes = linkFrontmatter(fm, [], matcher());

	assert.equal(changes.get("author"), "[[Ocean Service Group]]");
	assert.equal(changes.get("publisher"), "[[Tokyo]]");
	assert.deepEqual(changes.get("related"), [
		"[[Tokyo]]",
		"nothing here",
		"[[Berlin]]",
	]);
	// Untouched: no match, reserved, and not a name.
	assert.ok(!changes.has("status"));
	assert.ok(!changes.has("tags"));
	assert.ok(!changes.has("published"));
});

test("reports no changes when there is nothing to do", () => {
	const changes = linkFrontmatter(
		{ author: "[[Tokyo]]", tags: "Tokyo" },
		[],
		matcher()
	);
	assert.equal(changes.size, 0);
});
