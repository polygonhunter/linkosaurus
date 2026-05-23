# AutoLink Keywords

An Obsidian plugin that automatically converts keywords into `[[wikilinks]]` as you type. Works on desktop and mobile (iOS/Android).

## Features

### Auto-linking on Space

Type a keyword and press Space — it becomes a wikilink automatically.

| You type | Result |
|----------|--------|
| `Dortmund ` | `[[Dortmund]] ` |
| `NAS ` | `[[UGREEN NAS\|NAS]] ` (with alias mapping) |

### Alias syntax with `///`

Type `displayText///keyword` followed by Space to create an aliased wikilink:

| You type | Result |
|----------|--------|
| `unterwegs///Dortmund ` | `[[Dortmund\|unterwegs]] ` |

Only triggers if the target keyword exists in the keyword list.

### Multi-word keywords

When both `New` and `New York` exist as keywords, the plugin handles this gracefully:

1. `New` + Space → `[[New]] ` (linked immediately)
2. You type `Y` → the plugin detects that `New Y...` could become `New York`, undoes the link → `New Y`
3. You type `ork` + Space → `[[New York]] `

If you type something that doesn't continue a longer keyword (e.g. `H`), the `[[New]]` link stays.

### Auto-detect vault notes

When enabled (default), **all note names** in your vault automatically become keywords. Creating a new note instantly makes its name auto-linkable — no manual configuration needed.

Existing wikilinks in your vault are also detected, so linked-to notes that don't exist yet still get auto-linked.

### Shortcut command

Select a word (or place your cursor on one) and run the command **"Link selection and add to keyword list"** to:
- Wrap it in `[[wikilinks]]`
- Add it to your manual keyword list

Assign a hotkey in Settings → Hotkeys.

## Keyword list format

Configured in plugin settings as plain text, one entry per line.

```
# Comments start with #
Dortmund
Lippstadt

# Alias mapping: keyword = target note
NAS = UGREEN NAS
```

**Rules:**
- `Dortmund` — keyword and target are identical → `[[Dortmund]]`
- `NAS = UGREEN NAS` — left is keyword, right is target → `[[UGREEN NAS|NAS]]`
- Lines starting with `#` are comments
- Empty lines are ignored
- Matching is case-insensitive
- Manual entries take priority over auto-detected vault keywords

## Settings

| Setting | Description |
|---------|-------------|
| **Keyword list** | Monospace textarea for manual keywords |
| **Auto-detect vault links** | Toggle to automatically use all note names as keywords. Shows a collapsible list of detected keywords. |

## Where it won't trigger

- Inside existing `[[wikilinks]]`
- Inside code blocks (fenced or inline)
- When text already starts with `[[`

## Installation

### Via BRAT (recommended for mobile)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. In BRAT settings, click **Add beta plugin**
3. Enter: `polygonhunter/linkosaurus`
4. Enable **AutoLink Keywords** in Community Plugins

### Manual

1. Clone this repository
2. `npm install && npm run build`
3. Copy `main.js` and `manifest.json` to `.obsidian/plugins/autolink-keywords/`
4. Enable the plugin in Obsidian settings

## Technical details

- Uses `EditorView.inputHandler` (CodeMirror 6) to intercept Space input — works reliably on both desktop and mobile virtual keyboards
- Atomic replacements via `view.dispatch()` transactions
- Vault scanning uses Obsidian's `metadataCache` with 2-second debounce
- All timers are cleaned up on plugin unload
