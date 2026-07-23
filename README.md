<p align="center">
  <img src="linkosaurus.svg" alt="Linkosaurus" width="200">
</p>

<div align="center">

# Linkosaurus

**Your vault links itself.**

</div>

Linkosaurus turns plain text into wikilinks *as you type*. Write a keyword, press Space — and the link is already there. No reaching for `[[`, no autocomplete popup to fight, no breaking your train of thought. You just write, and your notes quietly weave themselves together.

I built Linkosaurus because I wanted linking to disappear as a task. In a good vault the connections between notes are the whole point — but stopping to type brackets, wait for a suggestion list, and pick the right entry pulls me out of writing every single time. So I made a plugin that does it in the background: it watches for the note names, aliases, and keywords you already care about, and links them the moment you finish a word. It works on desktop and mobile, and it runs entirely offline.

Linkosaurus keeps growing, but it's meant to stay small and quiet — a plugin you forget is running until you notice your notes are all connected. If something feels off or you have an idea, [open an issue on GitHub](https://github.com/polygonhunter/linkosaurus/issues); I read everything.

## What it looks like

| You type | Linkosaurus writes |
|----------|--------------------|
| `Tokyo ` | `[[Tokyo]] ` |
| `ML ` | `[[Machine Learning\|ML]] ` |
| `Berlin.` | `[[Berlin]].` |
| `(Paris)` | `([[Paris]])` |
| `Eibel - Facebook ` | `[[Eibel]] - [[Facebook]] ` |
| `trip//Tokyo ` | `[[Tokyo\|trip]] ` |
| `///cherry blossoms///Tokyo ` | `[[Tokyo\|cherry blossoms]] ` |
| `youtube.com ` | `[youtube.com](https://youtube.com) ` |
| `https://www.example.com/blog ` | `[example.com/blog](https://www.example.com/blog) ` |

And while you're writing an inline alias, an autocomplete popup floats in beside the cursor and suggests the target as you type — **Enter** or **Tab** drops the finished link. On by default, one switch turns it off.

Need a note the auto-linker can't reach — say `Eibel - IT Termin`, where `Eibel` links before the full name has a chance? Type `;;` and the same popup becomes a search across everything linkable in your vault. Pick the note, and `[[Eibel - IT Termin]]` lands whole.

## Features

### Auto-link while you type

This is the heart of the plugin. Linkosaurus watches the word (or words) you just finished and, the instant you press **Space**, **Enter**, or common punctuation — `)` `.` `,` `!` `?` `:` `;` — it replaces a match with the right wikilink. You never stop writing.

### Names and separators stay intact

If you keep sub-notes like `Eibel - Instagram` and `Eibel - Facebook` alongside a main `Eibel` note, Linkosaurus links each piece on its own: typing `Eibel - Facebook` gives you `[[Eibel]] - [[Facebook]]`. The person stays linked, the platform gets its own link, and the separator is left alone.

### Multi-word keywords with smart undo

When one keyword is the beginning of a longer one, Linkosaurus waits a beat to see where you're going.

With both `Open` and `Open Source` in your list:

1. `Open ` → `[[Open]]`
2. You type `S` → Linkosaurus realises `Open S…` might become `Open Source`, quietly undoes the link → `Open S`
3. You type `ource ` → `[[Open Source]]`

If your next character *can't* continue the longer term (`Open H…`), the original `[[Open]]` link simply stays. You always end up with the most specific link, and you never have to think about it.

### Inline aliases

Sometimes the word on the page isn't the note's name. Add display text without breaking flow:

**Single-word** (default delimiter `//`):

```
trip//Tokyo  →  [[Tokyo|trip]]
```

**Multi-word** (default delimiter `///`):

```
///cherry blossoms///Tokyo  →  [[Tokyo|cherry blossoms]]
```

The target on the right must exist in your keyword list, and both delimiters are configurable.

### Alias autocomplete

You don't have to remember the target's exact name. The moment you start typing the target part of an alias, a small panel floats in beside the cursor with matching suggestions — fuzzy-matched from your note names, keywords, and frontmatter aliases:

```
Urlaub//B▌
┌──────────────────┐
│ 🔗 Berlin        │
│ 🔗 Bielefeld     │
└──────────────────┘
```

Arrow keys to choose, **Enter** or **Tab** to link — `[[Berlin|Urlaub]]` lands fully formed, no trailing space needed. Keep typing to narrow the list (`Bln` still finds Berlin), or press Esc and finish the alias by hand; the classic flow is untouched, and the popup never picks for you.

The whole thing is **on by default** and lives behind a single switch — *Settings → Alias target suggestions* — if you'd rather write without it. Both accept keys have their own toggle on top: turn Enter off to keep it for line breaks and link with Tab alone, or the other way around.

### Quick link search

Auto-linking fires the moment a word ends — which means a note like `Eibel - IT Termin` is unreachable by typing alone: `Eibel` links first, and the rest of the name never gets its turn. For those, summon the search. Type `;;` and the popup appears again, now listing *everything* linkable in your vault — note names, keywords, frontmatter aliases — and filtering as you type. Spaces are fine:

```
;;Eibel - I▌
┌────────────────────────┐
│ 🔗 Eibel - IT Termin   │
└────────────────────────┘
```

**Enter**, **Tab**, or a click replaces the whole search — trigger and all — with `[[Eibel - IT Termin]]`. Mappings behave exactly like the auto-linker: picking `ML` inserts `[[Machine Learning|ML]]`.

The search only starts when you mean it: the trigger does nothing mid-word, doubled up, or followed by a space — so if you change it to `*` (it's configurable in the settings), your bullet lists and bold text stay popup-free. It shares the Enter/Tab accept toggles with the alias autocomplete, and its own switch — *Settings → Note search popup* — turns it off entirely.

With vault scanning on (the default), every note name becomes a keyword the moment the note exists — create `Project Aurora.md` and it's instantly auto-linkable everywhere. Linkosaurus also picks up wikilinks pointing at notes you *haven't written yet*, so you can link forward and let the notes catch up later.

### Frontmatter aliases

Linkosaurus reads the `aliases:` field from your YAML frontmatter. If `Tokyo.md` lists `Edo` as an alias, typing `Edo` links straight to `[[Tokyo|Edo]]`. Toggleable.

### Case-insensitive matching

`tokyo`, `Tokyo`, and `TOKYO` all resolve to the same note. Toggleable.

### Paste and dictation

Text you paste or dictate is scanned in a single pass — keywords and URLs alike are converted as it lands, so pasted paragraphs come in pre-linked.

### Auto-link URLs

Plain web addresses become tidy Markdown links on their own:

| You type | Linkosaurus writes |
|----------|--------------------|
| `https://www.github.com` | `[github.com](https://www.github.com)` |
| `github.com` | `[github.com](https://github.com)` |
| `http://example.com/blog` | `[example.com/blog](http://example.com/blog)` |
| `https://shop.example.com/p?id=1` | `[shop.example.com/p](https://shop.example.com/p?id=1)` |

The display text strips the protocol, `www.`, query string, fragment, and trailing slash; the link target keeps the full URL. Bare domains are only linked when their top-level domain is in your allowlist (defaults: `de com org net io shop app dev` — editable). Toggleable.

### Periodic auto-relink

New keywords don't reach back in time on their own — a note created today won't have its name linked in a note you wrote last week. Turn on periodic auto-relink and Linkosaurus re-scans the vault on a schedule (1–60 minutes), converting matches it finds in plain text. It also fires automatically (debounced) when you create or rename a note. Notes you have open are skipped so your cursor never jumps, and every existing rule is respected — blocklist, code blocks, frontmatter, URLs, and self-links.

Off by default; turn it on if you like your whole vault kept in sync.

### Bulk commands

| Command | What it does |
|---------|--------------|
| **Auto-link keywords in current note** | Links every matching keyword in the note you're in, in one pass |
| **Auto-link keywords in all notes** | A one-shot sweep across the whole vault (open notes are skipped) |
| **Link selection and add to keyword list** | Links the selected word *and* remembers it as a keyword — assign a hotkey for the fastest possible workflow |

### Where Linkosaurus stays out of the way

It deliberately does nothing:

- Inside existing `[[wikilinks]]`
- Inside `[markdown](links)`
- Inside fenced or inline code blocks
- Inside URLs (unless URL auto-linking is on)
- Inside YAML frontmatter

## Keyword list syntax

You keep your own keywords in the plugin settings, one entry per line:

```
# Comments start with #
London
Tokyo

# Alias mapping: keyword = target note
ML = Machine Learning
```

- `London` — keyword and target are the same → `[[London]]`
- `ML = Machine Learning` — `ML` is what you type, `Machine Learning` is the note it links to → `[[Machine Learning|ML]]`
- Lines starting with `#` are comments; empty lines are ignored
- Manual entries always take priority over auto-detected vault keywords

## Settings

Linkosaurus ships with more knobs than most people will ever need — I tried to write a plain-language explanation for each one, so browse the settings tab and the option you're looking for is probably already there.

| Setting | Description |
|---------|-------------|
| **Keyword list** | Your manually defined keywords |
| **Case-insensitive matching** | Ignore case when matching |
| **Single-word alias delimiter** | Inline alias delimiter for single-word display text (default `//`) |
| **Multi-word alias delimiter** | Inline alias delimiter for multi-word display text (default `///`) |
| **Alias target suggestions** | Autocomplete popup for the target part of an alias (on by default) |
| **Accept suggestion with Enter** | Enter links the highlighted suggestion (on by default) |
| **Accept suggestion with Tab** | Tab links the highlighted suggestion (on by default) |
| **Auto-detect vault links** | Use every note name in the vault as a keyword |
| **Include frontmatter aliases** | Use `aliases:` fields from frontmatter as keywords |
| **Minimum keyword length** | Floor for auto-detected keyword length (0 = no limit) |
| **Blocklist** | Keywords excluded from auto-linking (e.g. `Home`, `Inbox`, `Daily`) |
| **Folder filter mode** | Include or exclude folders |
| **Folder filter** | Folders to filter from vault scanning |
| **Enable periodic auto-relink** | Periodic vault scan that retroactively links keywords (off by default) |
| **Relink interval (minutes)** | How often to scan (1–60 minutes, default 5) |
| **Auto-link website URLs** | Convert `http(s)://…` and bare domains to Markdown links (on by default) |
| **URL top-level domains** | TLDs recognised for bare domains (one per line) |

## Privacy

I treat privacy as the default, not a feature. Linkosaurus runs **entirely on your device** — no notes, keywords, or URLs ever leave your vault, and the plugin makes no network requests of any kind. The only thing hosted anywhere is the open-source code, right here on GitHub.

## Installation

### From Community Plugins

1. Open **Settings → Community plugins → Browse**
2. Search for **Linkosaurus**
3. Click **Install**, then **Enable**

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/polygonhunter/linkosaurus/releases/latest)
2. Drop them into `<vault>/.obsidian/plugins/autolink-keywords/`
3. Enable Linkosaurus under **Settings → Community plugins**

## Feedback, questions, ideas

Linkosaurus is a small, one-person project, built and maintained alongside everything else in life. If you hit a bug, want a feature, or just want to tell me how you use it, please [head over to GitHub](https://github.com/polygonhunter/linkosaurus/issues) — it genuinely helps, and it's what keeps the plugin moving.

Happy linking. 🦕
