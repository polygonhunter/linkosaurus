# Linkosaurus

**Your vault links itself.**

Linkosaurus turns Obsidian into a smart note-taking system that automatically detects connections between your thoughts — while you type, dictate, or paste. No more manual `[[`. No interrupting your writing flow. Just type a keyword, press Space (or Enter, or a punctuation mark), and the link appears.

Works on desktop and mobile (iOS/Android).

---

## Features

### Auto-link while typing

Type a keyword and press Space, Enter, or any common punctuation — Linkosaurus recognizes it instantly and creates the matching wikilink.

| You type | Result |
|----------|--------|
| `Dortmund ` | `[[Dortmund]] ` |
| `NAS ` | `[[UGREEN NAS\|NAS]] ` (with alias mapping) |
| `Dortmund.` | `[[Dortmund]].` |
| `(Dortmund)` | `([[Dortmund]])` |
| `Dortmund⏎` | `[[Dortmund]]` + new line |

Supported triggers: Space, Enter, `)` `.` `,` `!` `?` `:` `;`

### Alias syntax

Create links with custom display text while writing. Perfect for natural reading flow.

**Single-word alias** (default delimiter `//`):

| You type | Result |
|----------|--------|
| `York//Urlaub ` | `[[Urlaub\|York]] ` |

**Multi-word alias** (default delimiter `///`):

| You type | Result |
|----------|--------|
| `///New York///Urlaub ` | `[[Urlaub\|New York]] ` |

Only works when the target keyword exists in the keyword list. Both delimiters are configurable in the settings.

### Multi-word keywords

Linkosaurus recognizes compound terms like "New York" automatically — even when "New" alone is also a keyword:

1. `New` + Space → `[[New]]` (linked immediately)
2. You type `Y` → Linkosaurus detects that `New Y...` could become `New York`, undoes the link → `New Y`
3. You type `ork` + Space → `[[New York]]`

If you type something that doesn't continue a longer term (e.g. `H`), the `[[New]]` link stays.

### Vault scanning

When enabled (default), **all note names** in your vault automatically become keywords. Creating a new note makes its name instantly auto-linkable — no manual configuration needed.

Existing wikilinks in your vault are also detected, so linked notes that don't exist yet are auto-linked as well.

### Frontmatter aliases

Uses the `aliases` fields from your notes' YAML frontmatter as additional keywords. If a note "Dortmund" has the alias "BVB City", typing "BVB City" will also auto-link — directly to the right note. Can be toggled in settings.

### Case-insensitive matching

Whether you type "dortmund", "Dortmund", or "DORTMUND" — Linkosaurus recognizes the keyword and links it. Can be toggled per preference.

### Bulk auto-link existing text

The command **"Auto-link keywords in current note"** scans your current note and links all recognized keywords at once. Frontmatter, code blocks, existing links, and URLs are left untouched. The note never links to itself.

### Paste & dictation

Pasted or dictated text is automatically checked for keywords and linked — no manual post-processing needed.

### Blocklist

Don't want certain terms like "Home", "TODO", or "Daily" to be auto-linked? Just add them to the blocklist (one per line). Only affects auto-detected keywords, not manually defined ones.

### Minimum keyword length

Set a minimum length for auto-detected keywords to prevent accidental linking of short words. Manual keywords are unaffected.

### Folder filter

Control which folders are included or excluded from vault scanning. Ideal for keeping Templates, Daily Notes, or archive folders out of auto-linking.

### Periodic auto-relink

When a new note is created (e.g. `Kerstin.md`), existing notes that mention "Kerstin" as plain text still won't have a link — because the keyword didn't exist when they were written. Periodic auto-relink fixes this: it scans your entire vault at a configurable interval (1–60 minutes) and retroactively converts plain-text keywords to wikilinks.

- **Disabled by default** — enable in settings
- Also triggers automatically (with debounce) when a note is created or renamed
- Notes currently open in the editor are skipped to avoid cursor jumps
- Respects all existing rules: blocklist, self-link prevention, code blocks, frontmatter, URLs

### Vault-wide auto-link command

The command **"Auto-link keywords in all notes"** scans every note in the vault and links all recognized keywords at once — a manual one-shot alternative to periodic auto-relink. Open notes are skipped.

### Shortcut command

Select a word (or place the cursor on it) and run **"Link selection and add to keyword list"** — the word is linked immediately and added to the keyword list at the same time. Assignable to a hotkey under Settings → Hotkeys.

---

## Keyword list

Configured in the plugin settings as plain text, one entry per line.

```
# Comments start with #
Dortmund
Lippstadt

# Alias mapping: keyword = target note
NAS = UGREEN NAS
```

**Rules:**
- `Dortmund` — keyword and target are identical → `[[Dortmund]]`
- `NAS = UGREEN NAS` — left is the keyword, right is the target → `[[UGREEN NAS|NAS]]`
- Lines starting with `#` are comments
- Empty lines are ignored
- Manual entries take priority over auto-detected vault keywords

---

## Settings

| Setting | Description |
|---------|-------------|
| **Keyword list** | Text area for manually defined keywords |
| **Case-insensitive matching** | Ignore upper/lower case when matching |
| **Single-word alias delimiter** | Delimiter for single-word aliases (default `//`) |
| **Multi-word alias delimiter** | Delimiter for multi-word aliases (default `///`) |
| **Auto-detect vault links** | Automatically use all note names as keywords |
| **Include frontmatter aliases** | Use aliases from frontmatter as keywords |
| **Minimum keyword length** | Minimum length for auto-detected keywords (0 = no limit) |
| **Blocklist** | Keywords excluded from auto-linking |
| **Folder filter mode** | Include or exclude folders |
| **Folder filter** | List of folders to filter |
| **Enable periodic auto-relink** | Periodically scan all notes and retroactively link keywords (off by default) |
| **Relink interval (minutes)** | How often to scan the vault (1–60 minutes, default: 5) |

---

## Where it won't trigger

- Inside existing `[[wikilinks]]`
- In code blocks (fenced or inline)
- In URLs
- In YAML frontmatter
- When the text already starts with `[[`

---

## Privacy

Linkosaurus runs **entirely locally**. No notes, no keywords, no data ever leaves your device. Only the plugin code is hosted on GitHub.

---

## Installation

### From Obsidian Community Plugins

1. Open **Settings → Community plugins → Browse**
2. Search for **Linkosaurus**
3. Click **Install**, then **Enable**

### Via BRAT

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. In BRAT settings: **Add beta plugin**
3. Enter: `polygonhunter/linkosaurus`
4. Enable **Linkosaurus** in Community Plugins

### Manual

1. Clone the repository
2. `npm install && npm run build`
3. Copy `main.js` and `manifest.json` to `.obsidian/plugins/autolink-keywords/`
4. Enable the plugin in Obsidian settings
