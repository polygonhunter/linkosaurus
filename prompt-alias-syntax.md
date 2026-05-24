## Implementierungsplan: Konfigurierbare Alias-Syntax für Linkosaurus

### Kontext

Linkosaurus ist ein Obsidian-Plugin, das Keywords automatisch beim Tippen in Wikilinks umwandelt. Der gesamte Quellcode liegt in `src/main.ts`. Die aktuelle Syntax für Alias-Links ist `displayText///keyword` (Triple-Slash), die aber bei mehrteiligen Display-Texten wie "New York" scheitert, weil der Space zwischen "New" und "York" die Erkennung unterbricht -- nur das letzte Wort vor `///` wird als Display-Text erfasst.

### Aufgabe

Implementiere zwei neue Alias-Syntaxen, die die bisherige Triple-Slash-Syntax ersetzen. Die Trennzeichen sollen in den Plugin-Einstellungen konfigurierbar sein.

### Neue Syntax-Regeln

**1. Einzelwort-Alias (Standard-Trennzeichen: `//`)**

```
York//Urlaub   →   [[Urlaub|York]]
```

- Ein einzelnes Wort vor dem Trennzeichen wird als Display-Text verwendet
- Nach dem Trennzeichen folgt das Link-Ziel
- Ausgelöst durch Space nach dem Ziel

**2. Mehrwort-Alias (Standard-Trennzeichen: `///`)**

```
///New York///Urlaub   →   [[Urlaub|New York]]
```

- Das Trennzeichen umklammert den Display-Text: es steht am Anfang und trennt Display-Text vom Ziel
- Alles zwischen dem ersten und zweiten Vorkommen des Trennzeichens ist der Display-Text (kann Leerzeichen enthalten)
- Nach dem zweiten Trennzeichen folgt das Link-Ziel
- Ausgelöst durch Space nach dem Ziel

### Konfigurierbare Trennzeichen

Beide Trennzeichen sollen in den Plugin-Einstellungen frei konfigurierbar sein:

- **Einstellung 1**: "Einzelwort-Alias-Trennzeichen" (Default: `//`)
- **Einstellung 2**: "Mehrwort-Alias-Trennzeichen" (Default: `///`)
- Der User kann beliebige Zeichenketten eintragen, z.B. `\\`, `---`, `###`, `ppppp` -- was auch immer gewünscht ist
- Validierung: Die beiden Trennzeichen dürfen nicht identisch sein. Beide Felder dürfen nicht leer sein. Warnung anzeigen, wenn ein Trennzeichen ein Substring des anderen ist (z.B. `//` und `///`), da das zu Parsing-Konflikten führen kann. Falls das Mehrwort-Trennzeichen ein Substring des Einzelwort-Trennzeichens ist oder umgekehrt, muss der Parser das längere Trennzeichen zuerst prüfen.

### Sicherheitsregeln

- URL-Schutz: Wenn dem Einzelwort-Trennzeichen direkt ein `:` vorangeht (also `://`), darf keine Erkennung ausgelöst werden. Dieser Schutz gilt für das Default-Trennzeichen `//` und muss generalisiert werden: Bei jedem konfigurierten Trennzeichen prüfen, ob es Teil einer URL sein könnte.
- Das Ziel muss weiterhin in der Keyword-Liste stehen (wie bisher). Da alle existierenden Notizen automatisch durch den Vault-Scan als Keywords erfasst werden, ist das keine Einschränkung -- es schützt nur vor Verlinkungen auf nicht-existierende Notizen.

### Zu ändernde Bereiche in `src/main.ts`

1. **`AutoLinkSettings` Interface** -- Zwei neue Felder: `singleWordDelimiter` (Default `//`) und `multiWordDelimiter` (Default `///`)
2. **`DEFAULT_SETTINGS`** -- Defaults setzen
3. **`matchTripleSlash()` Methode** -- Umbenennen zu z.B. `matchAlias()`. Logik komplett überarbeiten: erst Mehrwort-Syntax prüfen (Text beginnt mit dem Mehrwort-Trennzeichen), dann Einzelwort-Syntax. Lookup gegen die Keyword-Liste bleibt bestehen.
4. **`handleSpaceInput()`** -- Aufrufe der umbenannten Methode anpassen
5. **`replaceKeywordsInText()`** -- Bulk-Replacement muss die neuen Syntaxen ebenfalls erkennen und umwandeln. URL-Schutz beibehalten und auf konfigurierbare Trennzeichen verallgemeinern.
6. **Settings-Tab** -- Zwei neue Textfelder im Plugin-Einstellungs-UI mit Beschreibung und Validierung. Die Beschreibung soll mit Beispielen zeigen, wie die jeweilige Syntax funktioniert.

### Bestehende Funktionalität (nicht ändern)

- Direkte Keyword-Erkennung (`Dortmund ` → `[[Dortmund]]`) bleibt unverändert
- Keyword-Liste mit `=`-Mapping (`NAS = UGREEN NAS`) bleibt unverändert
- Multi-Wort-Keyword-Logik (Pending Undo) bleibt unverändert
- Alle Context-Checks (Code, Wikilinks, Frontmatter, URLs) bleiben erhalten
- `sanitize()` Funktion bleibt unverändert

### Aktualisierung der README

Die README.md muss aktualisiert werden:

- Abschnitt "Inline Aliasing" überarbeiten: alte `///`-Syntax durch die beiden neuen Syntaxen ersetzen
- Beispiele für Einzelwort-Alias und Mehrwort-Alias hinzufügen
- Erwähnen, dass die Trennzeichen in den Einstellungen konfigurierbar sind
- Falls ein Abschnitt "Settings" existiert, die neuen Einstellungen dokumentieren
