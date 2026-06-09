# Linkosaurus

**Your vault links itself.**

Linkosaurus turns plain text into wikilinks as you type. Write a keyword, press Space — and the link is there. No more reaching for `[[`. No interruption to your writing flow.

Detects notes from your vault, custom keyword lists, frontmatter aliases, and website URLs. Works on desktop and mobile. Runs entirely offline.

---

## Highlights

| You type | Result |
|----------|--------|
| `Tokyo ` | `[[Tokyo]] ` |
| `ML ` | `[[Machine Learning\|ML]] ` |
| `Berlin.` | `[[Berlin]].` |
| `(Paris)` | `([[Paris]])` |
| `trip//Tokyo ` | `[[Tokyo\|trip]] ` |
| `///cherry blossoms///Tokyo ` | `[[Tokyo\|cherry blossoms]] ` |
| `youtube.com ` | `[youtube.com](https://youtube.com) ` |
| `https://www.example.com/blog ` | `[example.com/blog](https://www.example.com/blog) ` |

---

## Features

### Auto-link while you type

Triggers on Space, Enter, or any common punctuation: `)` `.` `,` `!` `?` `:` `;`

Linkosaurus matches the last word (or words) you typed against your keyword list and replaces them with the right wikilink.

### Multi-word keywords with smart undo

If a keyword is the prefix of a longer keyword, Linkosaurus waits to see what you type next.

With both `Open` and `Open Source` in your list:

1. `Open ` → `[[Open]]`
2. Type `S` → Linkosaurus sees that `Open S…` could become `Open Source` and undoes the link → `Open S`
3. Type `ource ` → `[[Open Source]]`

If your next character can't continue the longer term (e.g. `Open H`), the original `[[Open]]` link stays.

### Inline aliases

Add custom display text without breaking your writing flow.

**Single-word** (default delimiter `//`):

```
trip//Tokyo  →  [[Tokyo|trip]]
```

**Multi-word** (default delimiter `///`):

```
///cherry blossoms///Tokyo  →  [[Tokyo|cherry blossoms]]
```

The target on the right must exist in the keyword list. Both delimiters are configurable.

### Vault scanning

When enabled (default), every note name in your vault becomes a keyword automatically. Create a new note and its name is auto-linkable immediately. Linkosaurus also picks up wikilinks to notes that don't exist yet, so you can link forward.

### Frontmatter aliases

Reads the `aliases:` field from your notes' YAML frontmatter. If a note `Tokyo.md` lists `Edo` as an alias, typing `Edo` links straight to `Tokyo`. Toggleable in settings.

### Case-insensitive matching

`tokyo`, `Tokyo`, and `TOKYO` all match the same keyword. Toggleable.

### Paste & dictation

Pasted or dictated text is scanned for keywords (and URLs, see below) and converted in one pass.

### Auto-link URLs

Plain URLs become Markdown links automatically — both fully-qualified URLs and bare domains.

| You type | Result |
|----------|--------|
| `https://www.github.com` | `[github.com](https://www.github.com)` |
| `github.com` | `[github.com](https://github.com)` |
| `http://example.com/blog` | `[example.com/blog](http://example.com/blog)` |
| `https://shop.example.com/p?id=1` | `[shop.example.com/p](https://shop.example.com/p?id=1)` |

The display strips the protocol, `www.`, query string, fragment, and trailing slash. The target preserves the full URL.

Bare domains are recognized only if their top-level domain is in the allowlist. Defaults: `de com org net io shop app dev` — editable in settings.

Toggleable per preference.

### Periodic auto-relink

New keywords don't reach back in time: a note created today won't have its name auto-linked in notes written yesterday. Periodic auto-relink fixes this by re-scanning the vault on a schedule (1–60 minutes) and converting matches it finds in plain text.

Disabled by default. Also triggers automatically (debounced) when a note is created or renamed. Open notes are skipped to avoid cursor jumps. Respects all existing rules: blocklist, code blocks, frontmatter, URLs, and self-link prevention.

### Bulk commands

| Command | What it does |
|---------|-------------|
| **Auto-link keywords in current note** | Scans the current note and links every matching keyword in one go |
| **Auto-link keywords in all notes** | One-shot scan over the entire vault (open notes are skipped) |
| **Link selection and add to keyword list** | Links the selected word *and* adds it to the keyword list — assign a hotkey for fastest workflow |

### Blocklist

Block specific keywords (e.g. `Home`, `Inbox`, `Daily`) from being auto-linked. Only applies to auto-detected vault keywords; manual entries are never blocked.

### Minimum keyword length

Set a floor for auto-detected keyword length to prevent accidental linking of short words. Manual entries ignore this limit.

### Folder filter

Include or exclude folders from vault scanning. Useful for excluding `Templates/`, `Daily/`, or archive directories.

### Where Linkosaurus stays out of the way

- Inside existing `[[wikilinks]]`
- Inside `[markdown](links)`
- Inside fenced or inline code blocks
- Inside URLs (unless URL auto-linking is enabled)
- Inside YAML frontmatter

---

## Keyword list syntax

Edit in the plugin settings, one entry per line.

```
# Comments start with #
London
Tokyo

# Alias mapping: keyword = target note
ML = Machine Learning
```

- `London` — keyword and target are the same → `[[London]]`
- `ML = Machine Learning` — `ML` is the keyword to match; `Machine Learning` is the linked note → `[[Machine Learning|ML]]`
- Lines starting with `#` are comments
- Empty lines are ignored
- Manual entries take priority over auto-detected vault keywords

---

## Settings

| Setting | Description |
|---------|-------------|
| **Keyword list** | Manually defined keywords |
| **Case-insensitive matching** | Ignore case when matching |
| **Single-word alias delimiter** | Inline alias delimiter for single-word display text (default `//`) |
| **Multi-word alias delimiter** | Inline alias delimiter for multi-word display text (default `///`) |
| **Auto-detect vault links** | Use every note name in the vault as a keyword |
| **Include frontmatter aliases** | Use `aliases:` fields from frontmatter as keywords |
| **Minimum keyword length** | Floor for auto-detected keyword length (0 = no limit) |
| **Blocklist** | Keywords excluded from auto-linking |
| **Folder filter mode** | Include or exclude folders |
| **Folder filter** | Folders to filter |
| **Enable periodic auto-relink** | Periodic vault scan that retroactively links keywords (off by default) |
| **Relink interval (minutes)** | How often to scan (1–60 minutes, default 5) |
| **Auto-link website URLs** | Convert `http(s)://…` and bare domains to Markdown links (on by default) |
| **URL top-level domains** | TLDs recognized for bare domains (one per line) |

---

## Privacy

Linkosaurus runs **entirely locally**. No notes, keywords, or URLs ever leave your device. Only the plugin code is hosted on GitHub.

---

## Installation

### From Community Plugins

1. Open **Settings → Community plugins → Browse**
2. Search for **Linkosaurus**
3. Click **Install**, then **Enable**

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/polygonhunter/linkosaurus/releases/latest)
2. Place them in `<vault>/.obsidian/plugins/autolink-keywords/`
3. Enable Linkosaurus under **Settings → Community plugins**
