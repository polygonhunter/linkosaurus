## 🦕 Links that stay out of your URLs

### 🐛 Fixes

- **URLs and domains stay whole.** Typing `github.com` no longer turns into `[[GitHub]].com`, and `https://www.github.com` is no longer linked halfway. URLs and email addresses are linked once the word is finished. A keyword linked on `.`, `:` or `?` is taken back when a letter or digit follows (`Node.js`, `Port:8080`).
- **Paste, dictation and the vault commands respect Markdown.** `<https://…>` autolinks and reference definitions like `[ref]: https://…` are left alone. URLs end before quotes, `**` and unmatched brackets, and `…/Foo_(bar)` stays whole. Keywords inside URLs, domains, footnote labels and block IDs are never linked.
- **No links inside a Markdown link you are still typing** (`[text](…`).
- **Rich paste works again.** Pasting HTML from a browser, pasting a URL over selected text, and pasting with several cursors are left to Obsidian.
- **Several cursors** no longer lose the typed space or punctuation.
- **Other scripts** are no longer folded in "All languages" mode: ガラス and カラス stay apart, Łukasz still finds Lukasz.
- An empty alias (`- ` in a note template) no longer becomes the keyword "null".
- Properties are not rewritten while you edit the YAML as text.
- "Auto-link keywords in current note" keeps your cursor and folds.
- Invalid settings show their red border again, and vault-wide commands report errors.
