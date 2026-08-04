## 🦕 Properties join in

Everything Linkosaurus does happens in the note body. Properties were a blind spot: you'd type a name into `author`, and it stayed plain text. Reaching for `[[` and picking from the menu was the only way.

Not anymore.

```
author: Ocean          →   author: "[[Ocean Service Group]]"
author: Tokyo          →   author: "[[Tokyo]]"
publisher: ML          →   publisher: "[[Machine Learning|ML]]"
```

Type the value, leave the field — the link is there, quoted correctly so the YAML stays valid.

### ✨ The details

- **Half a name is enough.** `Ocean` finds `Ocean Service Group`, as long as exactly one note starts that way. Two candidates and nothing happens, because guessing at your metadata is worse than doing nothing.
- **Whole values only.** A `description` full of prose is never rewritten — property fields hold one thing, and that one thing is what gets matched.
- **Your fields, your choice.** Name the properties you want linked, or leave the list empty for all of them. `tags`, `aliases` and `cssclasses` are never touched — wikilinks don't belong there.
- **Everything else still applies.** Mappings, accent matching, and the self-link guard work exactly as they do in the note body.
- **Catch up older notes** with the command *Link property values in current note*.

Off by default — it edits your files, so it should be your decision. Turn on *Link property values* in the settings.

### 🔍 One honest limitation

Linking happens when you *leave* the field, not while you type, and there's no suggestion popup inside a property field. Obsidian's property editor isn't part of the note editor, so plugins never see those keystrokes. For picking a note while typing there, Obsidian's own `[[` is still the tool.

Happy linking. 🦕
