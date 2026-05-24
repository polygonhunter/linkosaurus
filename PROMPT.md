# Implementierungsplan: Konfigurierbare Alias-Syntax für Linkosaurus

## Kontext

Linkosaurus ist ein Obsidian-Plugin, das Keywords automatisch beim Tippen in Wikilinks umwandelt. Der gesamte Quellcode liegt in `src/main.ts`. Die aktuelle Syntax für Alias-Links ist `displayText///keyword` (Triple-Slash), die aber bei mehrteiligen Display-Texten wie "New York" scheitert, weil der Space zwischen "New" und "York" die Erkennung unterbricht -- nur das letzte Wort vor `///` wird als Display-Text erfasst (Zeile 886: `preceding.lastIndexOf(" ")`).

## Aufgabe

Implementiere zwei neue Alias-Syntaxen, die die bisherige Triple-Slash-Syntax ersetzen. Die Trennzeichen sollen in den Plugin-Einstellungen konfigurierbar sein.

## Neue Syntax-Regeln

### 1. Einzelwort-Alias (Standard-Trennzeichen: `//`)

```
York//Urlaub   →   [[Urlaub|York]]
```

- Der Display-Text ist das eine Wort direkt vor dem Trennzeichen, begrenzt durch das nächste Whitespace links oder den Zeilenanfang
- Nach dem Trennzeichen folgt das Link-Ziel
- Ausgelöst durch Space nach dem Ziel
- Das Ziel wird in `lookupMap` nachgeschlagen. Nur wenn es dort existiert, wird die Alias-Syntax ausgelöst. Bei `=`-Mapping wird der gemappte Target verwendet: `York//NAS` mit `NAS = UGREEN NAS` → `[[UGREEN NAS|York]]`

### 2. Mehrwort-Alias (Standard-Trennzeichen: `///`)

```
///New York///Urlaub   →   [[Urlaub|New York]]
```

- Das Trennzeichen umklammert den Display-Text: es steht am Anfang und trennt Display-Text vom Ziel
- Der Display-Text liegt zwischen dem **ersten** und dem **zweiten** Vorkommen des Trennzeichens. Alles nach dem zweiten Vorkommen ist das Ziel -- auch wenn weitere Vorkommen des Trennzeichens im Ziel-Text stehen
- Der Display-Text darf Leerzeichen enthalten
- Ausgelöst durch Space nach dem Ziel
- Gleiches Lookup-Verhalten wie bei Einzelwort: Ziel muss in `lookupMap` existieren, gemappter Target wird verwendet

## Konfigurierbare Trennzeichen

Beide Trennzeichen sollen in den Plugin-Einstellungen frei konfigurierbar sein:

- **Einstellung 1**: "Single-word alias delimiter" (Default: `//`)
- **Einstellung 2**: "Multi-word alias delimiter" (Default: `///`)
- Der User kann beliebige Zeichenketten eintragen, z.B. `\\`, `---`, `###`, `ppppp`
- **Validierung:**
  - Beide Felder dürfen nicht leer sein
  - Die beiden Trennzeichen dürfen nicht identisch sein
  - Warnung anzeigen, wenn ein Trennzeichen ein Substring des anderen ist (z.B. `//` und `///`), da das zu Parsing-Konflikten führen kann

## Parsing-Reihenfolge

In `matchAlias()` (und überall sonst, wo beide Syntaxen geprüft werden) gilt: **Immer das längere Trennzeichen zuerst prüfen.** Wenn beide Trennzeichen gleich lang sind, Mehrwort zuerst. Mit den Defaults (`//` und `///`) wird also `///` zuerst geprüft. Wenn der User aber z.B. `####` als Einzelwort und `##` als Mehrwort konfiguriert, wird `####` zuerst geprüft.

## URL-Schutz

Wenn dem Trennzeichen direkt ein `:` vorangeht (z.B. `://`), darf keine Alias-Erkennung ausgelöst werden. Konkret: Prüfe, ob das Zeichen unmittelbar vor dem gefundenen Trennzeichen ein `:` ist -- wenn ja, ignoriere den Match. Das schützt vor Fehlerkennungen in URLs wie `https://example.com`.

## Zu ändernde Bereiche in `src/main.ts`

1. **`AutoLinkSettings` Interface (Zeile 5-16)** -- Zwei neue Felder: `singleWordDelimiter` (Default `//`) und `multiWordDelimiter` (Default `///`)

2. **`DEFAULT_SETTINGS` (Zeile 18-29)** -- Defaults setzen

3. **`matchTripleSlash()` Methode (Zeile 873-895)** -- Umbenennen zu `matchAlias()`. Logik komplett überarbeiten:
   - Beide Trennzeichen aus `this.settings` lesen
   - Das längere Trennzeichen zuerst prüfen
   - Mehrwort-Prüfung: Suche rückwärts nach dem Muster `<delimiter><displayText><delimiter><target>` im `textBefore`
   - Einzelwort-Prüfung: Suche rückwärts nach `<word><delimiter><target>`, wobei `<word>` durch Whitespace oder Zeilenanfang begrenzt ist
   - URL-Schutz anwenden (`:` vor dem Trennzeichen)
   - Lookup gegen `lookupMap` bleibt bestehen
   - Wikilink-Guard bleibt bestehen (`[[` am Anfang → kein Match)

4. **`handleSpaceInput()` (Zeile 242-310)** -- Aufruf von `matchTripleSlash` (Zeile 252) durch `matchAlias` ersetzen

5. **`replaceKeywordsInText()` (Zeile 389-563)** -- **Neue Funktionalität hinzufügen:** Diese Methode erkennt aktuell KEINE Alias-Syntax. Ergänze die Erkennung beider Alias-Syntaxen im Bulk-Text (Paste, Bulk-Input, Relink). Dabei:
   - Alias-Matches vor dem normalen Keyword-Matching prüfen (an der aktuellen Position im Text)
   - Bestehenden URL-Schutz (`http://`, `https://`) beibehalten
   - Zusätzlich den `:` vor Trennzeichen-Schutz anwenden
   - Bestehende Context-Skips (Code-Blöcke, Wikilinks, Frontmatter, Markdown-Links) beibehalten

6. **Settings-Tab (Zeile 981-1208)** -- Drei Änderungen:
   - **Bestehende Beschreibung aktualisieren (Zeile 997-1003):** Die alte Zeile `"<b>Alias syntax:</b> type <code>displayText///keyword</code> then Space → ..."` durch eine Beschreibung beider neuen Syntaxen ersetzen, mit Beispielen
   - **Neues Textfeld** für "Single-word alias delimiter" mit Beschreibung und Beispiel (`York//Urlaub → [[Urlaub|York]]`)
   - **Neues Textfeld** für "Multi-word alias delimiter" mit Beschreibung und Beispiel (`///New York///Urlaub → [[Urlaub|New York]]`)
   - Validierung: Fehlermeldung wenn leer oder identisch. Warnung wenn ein Trennzeichen Substring des anderen ist

## Bestehende Funktionalität (nicht ändern)

- Direkte Keyword-Erkennung (`Dortmund ` → `[[Dortmund]]`) bleibt unverändert
- Keyword-Liste mit `=`-Mapping (`NAS = UGREEN NAS`) bleibt unverändert
- Multi-Wort-Keyword-Logik (Pending Undo) bleibt unverändert
- Alle Context-Checks (Code, Wikilinks, Frontmatter, URLs) bleiben erhalten
- `sanitize()` Funktion bleibt unverändert
- Self-Link-Schutz in `handleSpaceInput()` (Zeile 254-256) bleibt erhalten

## Aktualisierung der README

Die README.md muss aktualisiert werden:

- Abschnitt "Alias syntax with `///`" (Zeile 22-29) überarbeiten: alte `///`-Syntax durch die beiden neuen Syntaxen ersetzen
- Beispiele für Einzelwort-Alias und Mehrwort-Alias hinzufügen
- Erwähnen, dass die Trennzeichen in den Einstellungen konfigurierbar sind
- Settings-Tabelle (Zeile 106-115) um die neuen Einstellungen ergänzen
