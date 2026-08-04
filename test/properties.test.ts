import test from "node:test";
import assert from "node:assert/strict";
import {
	SETTINGS_VERSION,
	isLinkableProperty,
	isPropertyValueField,
	linkFrontmatter,
	linkPropertyValue,
	matchPropertySearchTrigger,
	migratePropertySettings,
	nextPropertyLinkAction,
	parsePropertyList,
	propertyLinkFromEntry,
	type PropertyMatcher,
} from "../src/properties";

const NOTES = ["Tokyo", "Museum of Natural History", "Machine Learning", "Łukasz Nowak"];
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

test("resolves an unambiguous prefix — the Museum case", () => {
	// A prefix hit writes the full note name, like picking it from Obsidian's
	// own [[ menu would.
	assert.equal(
		linkPropertyValue("Museum", matcher()),
		"[[Museum of Natural History]]"
	);
});

test("refuses an ambiguous prefix", () => {
	const twoMuseums = matcher({
		prefixCandidates: () => [
			"Museum of Natural History",
			"Museum of Modern Art",
		],
	});
	assert.equal(linkPropertyValue("Museum", twoMuseums), null);
});

test("two notes differing only by accent are not a unique prefix", () => {
	const bothZurichs = matcher({
		prefixCandidates: () => ["Zürich", "Zurich"],
	});
	assert.equal(linkPropertyValue("Zur", bothZurichs), null);
});

test("prefix matching can be switched off", () => {
	assert.equal(
		linkPropertyValue("Museum", matcher({ prefixMatchEnabled: false })),
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

// Mirrors Obsidian's property markup: an editable element inside the value
// cell qualifies, anything else does not. Verified against the real DOM in a
// browser; these stubs keep it that way.
function fieldStub(opts: {
	inValueCell: boolean;
	tagName?: string;
	contentEditable?: boolean;
}) {
	return {
		tagName: opts.tagName ?? "DIV",
		isContentEditable: opts.contentEditable ?? false,
		getAttribute: (name: string) =>
			name === "contenteditable" && opts.contentEditable ? "true" : null,
		closest: (selector: string) =>
			selector === ".metadata-property-value" && opts.inValueCell
				? {}
				: null,
	};
}

test("recognises the editable part of a property value", () => {
	// Text property: contenteditable div in the value cell.
	assert.ok(
		isPropertyValueField(
			fieldStub({ inValueCell: true, contentEditable: true })
		)
	);
	// Date and number properties use plain inputs.
	assert.ok(
		isPropertyValueField(fieldStub({ inValueCell: true, tagName: "INPUT" }))
	);
});

test("ignores anything outside a property value", () => {
	// The note editor — the existing popup already covers it.
	assert.ok(
		!isPropertyValueField(
			fieldStub({ inValueCell: false, contentEditable: true })
		)
	);
	// The property *name* field must keep its own suggestions.
	assert.ok(
		!isPropertyValueField(fieldStub({ inValueCell: false, tagName: "INPUT" }))
	);
	// A non-editable element inside the value cell (the rendered link).
	assert.ok(!isPropertyValueField(fieldStub({ inValueCell: true })));
});

test("finds the search trigger in a property value", () => {
	assert.deepEqual(matchPropertySearchTrigger(";;", ";;"), { query: "" });
	assert.deepEqual(matchPropertySearchTrigger(";;Tok", ";;"), { query: "Tok" });
	// Spaces belong to the search, as in the note body.
	assert.deepEqual(matchPropertySearchTrigger(";;Museum of", ";;"), {
		query: "Museum of",
	});
});

test("the trigger stays inert where it is ordinary text", () => {
	assert.equal(matchPropertySearchTrigger("", ";;"), null);
	assert.equal(matchPropertySearchTrigger("Tokyo", ";;"), null);
	// Mid-word, tripled, or followed by a space.
	assert.equal(matchPropertySearchTrigger("a;;b", ";;"), null);
	assert.equal(matchPropertySearchTrigger(";;; ", ";;"), null);
	assert.equal(matchPropertySearchTrigger(";; Tok", ";;"), null);
	// Obsidian's own link picker owns this one.
	assert.equal(matchPropertySearchTrigger(";;[[Tok", ";;"), null);
});

test("a custom trigger is honoured", () => {
	assert.deepEqual(matchPropertySearchTrigger("*Tok", "*"), { query: "Tok" });
	assert.equal(matchPropertySearchTrigger(";;Tok", "*"), null);
});

test("a picked suggestion writes the mapping-aware link", () => {
	const fold = (t: string) => t.toLowerCase();
	assert.equal(
		propertyLinkFromEntry("Tokyo", "Tokyo", fold),
		"[[Tokyo]]"
	);
	assert.equal(
		propertyLinkFromEntry("ML", "Machine Learning", fold),
		"[[Machine Learning|ML]]"
	);
});

test("waits while a property field still has focus, never drops the work", () => {
	assert.equal(
		nextPropertyLinkAction({ focusInProperties: true }),
		"wait"
	);
	assert.equal(
		nextPropertyLinkAction({ focusInProperties: false }),
		"link"
	);
});

test("an empty list means every property but the reserved ones", () => {
	const allowed = parsePropertyList("");
	assert.deepEqual(allowed, []);
	assert.ok(isLinkableProperty("company", allowed));
	assert.ok(isLinkableProperty("attendees", allowed));
	assert.ok(!isLinkableProperty("tags", allowed));
});

test("settings from before the marker are put back to the defaults", () => {
	// What a vault carries after installing 4.3.0: switched off, narrow list.
	assert.deepEqual(
		migratePropertySettings({
			version: undefined,
			enabled: false,
			fields: "author\npublisher\nrelated\ntopic\npeople\nproject",
		}),
		{ version: SETTINGS_VERSION, enabled: true, fields: "" }
	);
});

test("a hand-edited list from before the marker is normalised too", () => {
	// It never took effect in 4.3.0, so it is not a choice worth keeping.
	assert.deepEqual(
		migratePropertySettings({
			version: undefined,
			enabled: false,
			fields: "company\nattendees",
		}),
		{ version: SETTINGS_VERSION, enabled: true, fields: "" }
	);
});

test("a choice made after the marker exists is respected", () => {
	assert.deepEqual(
		migratePropertySettings({
			version: SETTINGS_VERSION,
			enabled: false,
			fields: "company",
		}),
		{ version: SETTINGS_VERSION, enabled: false, fields: "company" }
	);
});

test("a fresh install ends up on the defaults with the marker set", () => {
	assert.deepEqual(
		migratePropertySettings({ version: 0, enabled: true, fields: "" }),
		{ version: SETTINGS_VERSION, enabled: true, fields: "" }
	);
});

test("parses the settings list", () => {
	assert.deepEqual(
		parsePropertyList("author\n Publisher \n\nauthor\n"),
		["author", "publisher"]
	);
});

test("walks a whole frontmatter block", () => {
	const fm = {
		author: "Museum",
		publisher: "Tokyo",
		status: "Some free text",
		tags: "Tokyo",
		published: "2026-08-04",
		related: ["Tokyo", "nothing here", "[[Berlin]]"],
	};
	const changes = linkFrontmatter(fm, [], matcher());

	assert.equal(changes.get("author"), "[[Museum of Natural History]]");
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
