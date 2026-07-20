## 🦕 A quick polish pass

3.5.0 brought the alias autocomplete — 3.5.1 makes it squeaky-clean for the Obsidian plugin review, and sneaks in a genuinely nicer settings experience while it's at it.

### 🔍 Settings you can search

Linkosaurus adopted Obsidian 1.13's new declarative settings API. Every option now shows up in Obsidian's **global settings search** — try typing "autocomplete", "blocklist", or "delimiter" into the settings search box and jump straight there. On older Obsidian versions the classic settings tab keeps working as before.

As a bonus, delimiter validation now shows up as a friendly inline message right under the field, instead of a toast notification.

### 🧹 Under the hood

- The suggestion popup's gliding pill now positions itself through Obsidian's sanctioned styling API (`setCssStyles`) — the one thing the automated plugin review flagged as an error.
- The README title is a proper Markdown heading, so automated checks can match it against the manifest.
- Obsidian API typings pinned to `^1.13.1`.

Nothing about linking itself changed. Happy linking. 🦕
