# Linkosaurus

**Dein Vault verlinkt sich von selbst.**

Linkosaurus verwandelt Obsidian in ein intelligentes Notizsystem, das Verbindungen zwischen deinen Gedanken automatisch erkennt — während du schreibst, diktierst oder einfügst. Kein manuelles `[[` mehr. Kein Unterbrechen deines Schreibflusses. Tippe einfach ein Keyword, drücke Leertaste, und der Link steht.

Funktioniert auf Desktop und Mobilgeräten (iOS/Android).

---

## Features

### Automatisches Verlinken beim Tippen

Tippe ein Keyword und drücke Leertaste — Linkosaurus erkennt es sofort und erstellt den passenden Wikilink.

| Du tippst | Ergebnis |
|-----------|----------|
| `Dortmund ` | `[[Dortmund]] ` |
| `NAS ` | `[[UGREEN NAS\|NAS]] ` (mit Alias-Mapping) |

### Alias-Syntax mit `///`

Erstelle Links mit benutzerdefiniertem Anzeigetext direkt beim Schreiben. Perfekt für natürlichen Lesefluss.

| Du tippst | Ergebnis |
|-----------|----------|
| `unterwegs///Dortmund ` | `[[Dortmund\|unterwegs]] ` |

Funktioniert nur, wenn das Ziel-Keyword in der Keyword-Liste existiert.

### Multi-Wort-Keywords

Linkosaurus erkennt zusammengesetzte Begriffe wie "New York" automatisch — selbst wenn "New" allein auch ein Keyword ist:

1. `New` + Leertaste → `[[New]]` (sofort verlinkt)
2. Du tippst `Y` → Linkosaurus erkennt, dass `New Y...` zu `New York` werden könnte, macht den Link rückgängig → `New Y`
3. Du tippst `ork` + Leertaste → `[[New York]]`

Wenn du etwas tippst, das keinen längeren Begriff fortsetzt (z.B. `H`), bleibt der `[[New]]`-Link bestehen.

### Vault-Scanning

Wenn aktiviert (Standard), werden **alle Notiznamen** in deinem Vault automatisch zu Keywords. Eine neue Notiz erstellen macht ihren Namen sofort auto-linkbar — keine manuelle Konfiguration nötig.

Bestehende Wikilinks in deinem Vault werden ebenfalls erkannt, sodass auch verlinkte Notizen, die noch nicht existieren, auto-verlinkt werden.

### Frontmatter-Aliases

Nutzt die `aliases`-Felder aus dem YAML-Frontmatter deiner Notizen als zusätzliche Keywords. Wenn eine Notiz "Dortmund" den Alias "BVB-Stadt" hat, wird auch "BVB-Stadt" automatisch verlinkt — direkt zur richtigen Notiz. Ein-/ausschaltbar in den Einstellungen.

### Case-insensitive Matching

Egal ob du "dortmund", "Dortmund" oder "DORTMUND" tippst — Linkosaurus erkennt das Keyword und verlinkt es. Ein-/ausschaltbar je nach Präferenz.

### Bestehende Texte nachträglich verlinken

Der Befehl **"Auto-link keywords in current note"** durchsucht deine aktuelle Notiz und verlinkt alle erkannten Keywords auf einen Schlag. Frontmatter, Code-Blöcke, bestehende Links und URLs bleiben dabei unangetastet. Die Notiz verlinkt nie auf sich selbst.

### Paste & Diktat

Eingefügter oder diktierter Text wird automatisch auf Keywords geprüft und verlinkt — ohne manuelles Nacharbeiten.

### Blocklist

Bestimmte Begriffe wie "Home", "TODO" oder "Daily" sollen nicht automatisch verlinkt werden? Trag sie einfach in die Blocklist ein (eine pro Zeile). Betrifft nur auto-erkannte Keywords, nicht manuell definierte.

### Minimale Keyword-Länge

Setze eine Mindestlänge für auto-erkannte Keywords, um versehentliches Verlinken von kurzen Wörtern zu vermeiden. Manuelle Keywords bleiben davon unberührt.

### Ordner-Filter

Bestimme, welche Ordner beim Vault-Scanning berücksichtigt oder ausgeschlossen werden. Ideal um Templates, Daily Notes oder Archiv-Ordner vom Auto-Linking auszunehmen.

### Shortcut-Befehl

Markiere ein Wort (oder platziere den Cursor darauf) und führe **"Link selection and add to keyword list"** aus — das Wort wird sofort verlinkt und gleichzeitig zur Keyword-Liste hinzugefügt. Einer Tastenkombination zuweisbar unter Einstellungen → Tastenkürzel.

---

## Keyword-Liste

Wird in den Plugin-Einstellungen als Klartext konfiguriert, ein Eintrag pro Zeile.

```
# Kommentare beginnen mit #
Dortmund
Lippstadt

# Alias-Mapping: Keyword = Zielnotiz
NAS = UGREEN NAS
```

**Regeln:**
- `Dortmund` — Keyword und Ziel sind identisch → `[[Dortmund]]`
- `NAS = UGREEN NAS` — links ist das Keyword, rechts das Ziel → `[[UGREEN NAS|NAS]]`
- Zeilen mit `#` am Anfang sind Kommentare
- Leere Zeilen werden ignoriert
- Manuelle Einträge haben Vorrang vor auto-erkannten Vault-Keywords

---

## Einstellungen

| Einstellung | Beschreibung |
|-------------|--------------|
| **Keyword list** | Textarea für manuell definierte Keywords |
| **Case-insensitive matching** | Groß-/Kleinschreibung beim Matching ignorieren |
| **Auto-detect vault links** | Alle Notiznamen automatisch als Keywords verwenden |
| **Include frontmatter aliases** | Aliases aus dem Frontmatter als Keywords nutzen |
| **Minimum keyword length** | Mindestlänge für auto-erkannte Keywords (0 = kein Limit) |
| **Blocklist** | Keywords, die vom Auto-Linking ausgeschlossen werden |
| **Folder filter mode** | Ordner ein- oder ausschließen |
| **Folder filter** | Liste der zu filternden Ordner |

---

## Wo es nicht auslöst

- Innerhalb bestehender `[[Wikilinks]]`
- In Code-Blöcken (fenced oder inline)
- In URLs
- In YAML-Frontmatter
- Wenn der Text bereits mit `[[` beginnt

---

## Datenschutz

Linkosaurus läuft **vollständig lokal**. Keine Notizen, keine Keywords, keine Daten verlassen deinen Rechner. Auf GitHub liegt ausschließlich der Plugin-Code.

---

## Installation

### Via BRAT (empfohlen für Mobilgeräte)

1. Installiere das [BRAT](https://github.com/TfTHacker/obsidian42-brat) Plugin
2. In den BRAT-Einstellungen: **Add beta plugin**
3. Eingeben: `polygonhunter/linkosaurus`
4. **Linkosaurus** in den Community Plugins aktivieren

### Manuell

1. Repository klonen
2. `npm install && npm run build`
3. `main.js` und `manifest.json` nach `.obsidian/plugins/autolink-keywords/` kopieren
4. Plugin in den Obsidian-Einstellungen aktivieren

---

## Technische Details

- Nutzt `EditorView.inputHandler` (CodeMirror 6) zur Eingabe-Interception — funktioniert zuverlässig auf Desktop und mobilen Tastaturen
- Atomare Ersetzungen via `view.dispatch()` Transaktionen
- Vault-Scanning über Obsidians `metadataCache` mit 2-Sekunden-Debounce
- Alle Timer werden beim Plugin-Entladen bereinigt
- Sichere Eingabebereinigung gegen Wikilink-Injection
