## 🦕 Your aliases now finish themselves

The big one this release: **alias autocomplete**. Start an inline alias, and a little glass panel floats in beside your cursor, suggesting the target before you've typed it.

```
Urlaub//B▌
┌──────────────────┐
│ 🔗 Berlin        │
│ 🔗 Bielefeld     │
└──────────────────┘
```

Arrow keys to choose, **Enter** to link — `[[Berlin|Urlaub]]` lands fully formed. No trailing space, no typing out `ielefeld`.

### ✨ What's inside

- **Fuzzy search** — suggestions are drawn live from your note names, keywords, and frontmatter aliases; `Bln` still finds Berlin, and mappings show where they lead (`ML → Machine Learning`).
- **Zero extra keystrokes** — selecting a suggestion writes the finished wikilink immediately.
- **A popup that knows its place** — it only appears inside the alias syntax (`//` and `///`, including your custom delimiters). Normal typing stays popup-free, URLs and code blocks stay untouched, and Esc dismisses it without a trace. It never picks for you: type the alias out by hand and everything works exactly as before.
- **Dressed for the occasion** — frosted-glass panel, a selection pill that glides between entries, and keyboard hints in the footer (`↵ link · esc dismiss`). Matches your theme in light and dark; on phones it steps back to the platform's flat look.
- **One toggle** — not your thing? *Settings → Alias target suggestions* turns it off.

Closes #10. Happy linking. 🦕
