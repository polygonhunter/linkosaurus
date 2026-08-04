import test from "node:test";
import assert from "node:assert/strict";
import {
	formatEmailAsMarkdownLink,
	isEmailAddress,
	isEmailBoundary,
	matchEmailAtEnd,
	matchEmailInText,
} from "../src/email";

test("recognises ordinary addresses", () => {
	assert.ok(isEmailAddress("team@example.com"));
	assert.ok(isEmailAddress("first.last@example.co.uk"));
	assert.ok(isEmailAddress("box+tag@sub.example.org"));
	assert.ok(isEmailAddress("a_b%c@example.museum"));
});

test("rejects near misses", () => {
	assert.ok(!isEmailAddress("team@example"));
	assert.ok(!isEmailAddress("team@.com"));
	assert.ok(!isEmailAddress("@example.com"));
	assert.ok(!isEmailAddress("team@example.c"));
	assert.ok(!isEmailAddress("team@example.com."));
	assert.ok(!isEmailAddress("two words@example.com"));
});

test("matches an address the cursor sits behind", () => {
	const m = matchEmailAtEnd("Write to team@example.com");
	assert.deepEqual(m, { start: 9, address: "team@example.com" });
});

test("matches an address that is the whole line", () => {
	const m = matchEmailAtEnd("team@example.com");
	assert.deepEqual(m, { start: 0, address: "team@example.com" });
});

test("trims trailing sentence punctuation", () => {
	assert.equal(matchEmailAtEnd("mail team@example.com.")?.address, "team@example.com");
	assert.equal(matchEmailAtEnd("mail team@example.com,")?.address, "team@example.com");
});

test("leaves addresses inside existing links alone", () => {
	assert.equal(matchEmailAtEnd("[team@example.com"), null);
	assert.equal(matchEmailAtEnd("(mailto:team@example.com"), null);
	assert.equal(matchEmailAtEnd("mailto:team@example.com"), null);
});

test("does not treat URL credentials as an address", () => {
	assert.equal(matchEmailAtEnd("https://user@host.com"), null);
});

test("needs a local part", () => {
	assert.equal(matchEmailAtEnd("@example.com"), null);
	assert.equal(matchEmailAtEnd("see @example.com"), null);
});

test("finds addresses in pasted text", () => {
	const text = "Reach team@example.com or sales@example.org today";
	const first = matchEmailInText(text, 6, " ");
	assert.deepEqual(first, { address: "team@example.com", end: 22 });

	const secondStart = text.indexOf("sales@");
	const second = matchEmailInText(text, secondStart, " ");
	assert.equal(second?.address, "sales@example.org");
	assert.equal(text.substring(secondStart, second?.end), "sales@example.org");
});

test("pasted addresses stop before sentence punctuation", () => {
	const text = "Mail team@example.com.";
	const m = matchEmailInText(text, 5, " ");
	assert.equal(m?.address, "team@example.com");
	assert.equal(m?.end, text.length - 1);
});

test("pasted scan skips addresses glued to other words", () => {
	assert.equal(matchEmailInText("xteam@example.com", 1, "x"), null);
	assert.equal(matchEmailInText("https://user@host.com", 8, "/"), null);
});

test("email boundary guards the URL matchers", () => {
	// "team@example.com" — the domain starts at index 5.
	assert.ok(isEmailBoundary("team@example.com", 5));
	// A bare handle is not an address, so the domain may still be linked.
	assert.ok(!isEmailBoundary("@example.com", 1));
	assert.ok(!isEmailBoundary("example.com", 0));
	assert.ok(!isEmailBoundary("see example.com", 4));
});

test("formats as a mailto link showing the address", () => {
	assert.equal(
		formatEmailAsMarkdownLink("team@example.com"),
		"[team@example.com](mailto:team@example.com)"
	);
});

test("escapes characters that would break the link syntax", () => {
	assert.equal(
		formatEmailAsMarkdownLink("a]b@example.com"),
		"[ab@example.com](mailto:a]b@example.com)"
	);
});
