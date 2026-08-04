<p align="center">
  <img src="linkosaurus.svg" alt="Linkosaurus" width="200">
</p>

<div align="center">

# Linkosaurus

**Your vault links itself.**

<a href="https://github.com/polygonhunter/linkosaurus/releases/latest"><img src="https://img.shields.io/github/v/release/polygonhunter/linkosaurus?label=latest&color=7c3aed" alt="Latest release"></a>
<a href="https://github.com/polygonhunter/linkosaurus/releases"><img src="https://img.shields.io/github/downloads/polygonhunter/linkosaurus/total?color=2ea44f" alt="Downloads"></a>
<a href="LICENSE"><img src="https://img.shields.io/github/license/polygonhunter/linkosaurus?color=blue" alt="License"></a>

</div>

Stop typing `[[`. Write a word, press Space — the wikilink is already there.

```
You type:            Tokyo and back.
Your note says:      [[Tokyo]] and back.
```

Works on desktop and mobile. Runs entirely offline. Zero setup: install, write, watch your vault connect itself.

## Why Linkosaurus?

### ⚡ Type. Space. Linked.

Linkosaurus watches the words you finish and links them the instant you hit **Space**, **Enter**, or punctuation — `)` `.` `,` `!` `?` `:` `;`. You never stop writing.

| You type | Linkosaurus writes |
|----------|--------------------|
| `Tokyo ` | `[[Tokyo]] ` |
| `ML ` | `[[Machine Learning\|ML]] ` |
| `Berlin.` | `[[Berlin]].` |
| `(Paris)` | `([[Paris]])` |
| `T-Rex - Facebook ` | `[[T-Rex]] - [[Facebook]] ` |

### ✨ Aliases that finish themselves

The word on the page isn't the note's name? Slip in an alias without breaking flow — `//` for one word, `///` for phrases:

```
trip//Tokyo                   →  [[Tokyo|trip]]
///cherry blossoms///Tokyo    →  [[Tokyo|cherry blossoms]]
```

And you don't even have to remember the note's name. Start typing the target and a popup floats in beside your cursor, fuzzy-matched from your note names, keywords, and frontmatter aliases:

```
trip//T▌
┌──────────────────┐
│ 🔗 Tokyo         │
│ 🔗 T-Rex         │
└──────────────────┘
```

**Enter** or **Tab** drops the finished link — `[[Tokyo|trip]]`, fully formed. (Choose wisely; a trip to the T-Rex is a very different itinerary.)

### 🔎 Search your vault mid-sentence

Some notes can't be reached by typing alone — `T-Rex - Feeding Schedule` never gets a chance, because `T-Rex` links first. So summon the search: type `;;` and the popup lists *everything* linkable in your vault, filtering as you type. Spaces are fine:

```
;;T-Rex - F▌
┌──────────────────────────────┐
│ 🔗 T-Rex - Feeding Schedule  │
└──────────────────────────────┘
```

One keypress replaces the whole search — trigger and all — with `[[T-Rex - Feeding Schedule]]`. Too lazy to type the full name? `;;feed` gets you there too. It's fuzzy.

### 🌐 URLs and emails tidy themselves

Plain web addresses become clean Markdown links on their own — and so do email addresses:

| You type | Linkosaurus writes |
|----------|--------------------|
| `https://www.github.com` | `[github.com](https://www.github.com)` |
| `github.com` | `[github.com](https://github.com)` |
| `https://shop.example.com/p?id=1` | `[shop.example.com/p](https://shop.example.com/p?id=1)` |
| `team@example.com` | `[team@example.com](mailto:team@example.com)` |

### 🧠 And it thinks ahead

- **Smart undo** — with `Open` and `Open Source` in your list, typing `Open S…` quietly unlinks `[[Open]]` and waits for the longer match. You always get the most specific link.
- **Separators stay intact** — `T-Rex - Facebook` → `[[T-Rex]] - [[Facebook]]`. The dinosaur keeps its link, the platform gets its own (your T-Rex has social media, no judgement).
- **It learns your vault** — every note name becomes linkable the moment the note exists; frontmatter `aliases:` too.
- **Accents optional** — type `Lukasz Nowak` and get `[[Łukasz Nowak]]`, correctly spelled. Works for every Latin-script language, in both directions.
- **Paste & dictation** — pasted or dictated text arrives pre-linked in a single pass.
- **Periodic auto-relink** — optionally re-scan your vault on a schedule so old notes catch up with new keywords.
- **Bulk commands** — link a whole note or the whole vault in one go.
- **Private by design** — everything runs on your device. No network requests, ever.

---

## The details

### Multi-word keywords with smart undo

When one keyword is the beginning of a longer one, Linkosaurus waits a beat to see where you're going.

With both `Open` and `Open Source` in your list:

1. `Open ` → `[[Open]]`
2. You type `S` → Linkosaurus realises `Open S…` might become `Open Source`, quietly undoes the link → `Open S`
3. You type `ource ` → `[[Open Source]]`

If your next character *can't* continue the longer term (`Open H…`), the original `[[Open]]` link simply stays. You never have to think about it.

### Alias autocomplete, in full

The suggestion popup only appears inside the alias syntax (`//` and `///`, including custom delimiters) — normal typing stays popup-free. Keep typing to narrow the list (`Tky` still finds Tokyo), press Esc to dismiss without a trace, or finish the alias by hand; the popup never picks for you. Both accept keys have their own toggle: turn Enter off to keep it for line breaks and link with Tab alone, or the other way around.

### The `;;` search, in full

The search only starts when you mean it: the trigger does nothing mid-word, doubled up, or followed by a space — so if you change it to `*` (it's configurable), your bullet lists and bold text stay popup-free. While a search is active the auto-linker stays out of its way, and Esc always dismisses cleanly. Mappings behave exactly like the auto-linker: picking `ML` inserts `[[Machine Learning|ML]]`.

### URL linking, in full

The display text strips the protocol, `www.`, query string, fragment, and trailing slash; the link target keeps the full URL. Bare domains are only linked when their top-level domain is in your allowlist (defaults: `de com org net io shop app dev` — editable). Toggleable.

### Email linking, in full

Addresses keep their full spelling as the link text: `team@example.com ` becomes `[team@example.com](mailto:team@example.com)`, ready to click. Unlike bare domains there is no allowlist to maintain — the `@` is signal enough, so `name@company.fr` links just like `.com` does. A sentence-ending `.` `,` `!` `?` stays outside the link, and addresses that already live inside a link, a `mailto:` target, or a URL like `https://user@host.com` are left alone. Toggleable — and with the toggle off, addresses stay plain text, untouched.

### Frontmatter aliases

Linkosaurus reads the `aliases:` field from your YAML frontmatter. If `Tokyo.md` lists `Edo` as an alias, typing `Edo` links straight to `[[Tokyo|Edo]]`. Toggleable.

### Case-insensitive matching

`tokyo`, `Tokyo`, and `TOKYO` all resolve to the same note. Toggleable.

### Accents optional

Your colleague's note is `Łukasz Nowak.md`, but your keyboard isn't Polish. Type `Lukasz Nowak ` and you still get `[[Łukasz Nowak]]` — spelled the way the note is, not the way you typed it.

It works for every Latin-script language, in both directions, with no letter lists to keep:

| You type | It finds |
|----------|----------|
| `Lukasz` | `Łukasz` (Polish) |
| `Gokhan Sahin` | `Gökhan Şahin` (Turkish) |
| `Dvorak` | `Dvořák` (Czech) |
| `Nguyen` | `Nguyễn` (Vietnamese) |
| `Soren` *or* `Soeren` | `Søren` (Danish) |
| `Mueller` | `Müller` (German) |
| `Strasse` | `Straße` |

The reverse works too — typing `Łukasz` finds a note named `Lukasz`.

**Languages.** The default, *All languages*, needs no setup and costs nothing: `ł` only ever means `l`, `ğ` only ever means `g`, so there is nothing for the languages to disagree about. Switch to *Only selected languages* if you'd rather keep some spellings matched exactly — then pick from Polish, Czech & Slovak, Turkish, German, Scandinavian, Icelandic, French, Spanish & Portuguese, Hungarian, Romanian, Baltic, Croatian & Serbian, and Vietnamese.

**Two notes that differ only by accent** — `Zürich.md` next to `Zurich.md` — keep their own identities. Linkosaurus notices the clash and falls back to exact spelling for that name alone, so neither ever links to the other. Every other name stays accent-tolerant.

**One thing it won't do:** if the note itself is named with the plain spelling (`Soeren.md`) and you type the special letter (`Søren`), there's no match. Going that direction would mean treating every `oe` in your writing as a possible `ø`, which turns `poem` into `pom`. Use `;;` search or a frontmatter alias for those.

On by default. Turn it off and matching goes back to exact spelling.

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

Linkosaurus ships with more knobs than most people will ever need — every option has a plain-language explanation, so browse the settings tab and the thing you're looking for is probably already there.

| Setting | Description |
|---------|-------------|
| **Keyword list** | Your manually defined keywords |
| **Case-insensitive matching** | Ignore case when matching |
| **Ignore accents and special letters** | Match across accents — `Lukasz` finds `Łukasz` (on by default) |
| **Languages** | All languages, or only the ones you pick |
| **Selected languages** | Which languages' characters are folded |
| **Single-word alias delimiter** | Inline alias delimiter for single-word display text (default `//`) |
| **Multi-word alias delimiter** | Inline alias delimiter for multi-word display text (default `///`) |
| **Alias target suggestions** | Autocomplete popup for the target part of an alias (on by default) |
| **Note search popup** | The `;;` quick search across everything linkable (on by default) |
| **Search trigger** | Characters that open the note search (default `;;`) |
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
| **Auto-link email addresses** | Turn typed or pasted addresses into `mailto:` links (on by default) |

## Privacy

Privacy is the default, not a feature. Linkosaurus runs **entirely on your device** — no notes, keywords, or URLs ever leave your vault, and the plugin makes no network requests of any kind. The only thing hosted anywhere is the open-source code, right here on GitHub.

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

I built Linkosaurus because I wanted linking to disappear as a task — in a good vault the connections are the whole point, and stopping to type brackets pulls you out of writing every single time. It's a small, one-person project, meant to stay quiet and fast: a plugin you forget is running until you notice your notes are all connected.

If you hit a bug, want a feature, or just want to tell me how you use it, [head over to GitHub](https://github.com/polygonhunter/linkosaurus/issues) — I read everything, and it's what keeps the plugin moving.

Happy linking. 🦕
