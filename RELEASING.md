# So veröffentlichst du ein neues Update

## Kurzversion

1. Code-Änderungen machen
2. Versionsnummer in 3 Dateien hochzählen
3. Committen und pushen
4. Fertig — der Rest passiert automatisch

---

## Schritt für Schritt

### 1. Änderungen am Plugin machen

Bearbeite die Dateien in `src/` wie gewünscht.

### 2. Plugin bauen

```bash
npm run build
```

Das erzeugt eine neue `main.js`.

### 3. Versionsnummer hochzählen

Die neue Version muss in **3 Dateien** stehen. Beispiel: von `3.0.2` auf `3.0.3`.

**manifest.json** — `"version"` ändern:
```json
{
  "version": "3.0.3"
}
```

**package.json** — `"version"` ändern:
```json
{
  "version": "3.0.3"
}
```

**versions.json** — neue Zeile ganz oben einfügen:
```json
{
  "3.0.3": "0.15.0",
  "3.0.2": "0.15.0",
  ...
}
```

Die Zahl rechts (`"0.15.0"`) ist die minimale Obsidian-Version. Die bleibt normalerweise gleich.

### 4. Committen und pushen

```bash
git add main.js manifest.json package.json versions.json
git commit -m "Release 3.0.3"
git push
```

### 5. Fertig!

GitHub erkennt automatisch, dass sich `manifest.json` geändert hat, und:
- Baut das Plugin nochmal sauber
- Erstellt einen neuen Release mit Release Notes
- Fügt ein Sicherheitszertifikat hinzu
- Lädt `main.js` und `manifest.json` als Download hoch

Obsidian erkennt den neuen Release und bietet das Update deinen Nutzern an.

---

## Versionsnummern

Das Format ist `X.Y.Z`:
- **X** hochzählen bei großen, nicht-kompatiblen Änderungen (z.B. 3.0.0 → 4.0.0)
- **Y** hochzählen bei neuen Features (z.B. 3.0.0 → 3.1.0)
- **Z** hochzählen bei Bugfixes (z.B. 3.0.0 → 3.0.1)

---

## Häufige Fehler

| Problem | Lösung |
|---------|--------|
| Release wurde nicht erstellt | Prüfe ob `manifest.json` geändert und gepusht wurde |
| Falscher Versionsname im Release | Prüfe ob die Version in allen 3 Dateien gleich ist |
| Nutzer sehen das Update nicht | Kann bis zu 24h dauern, bis Obsidian es erkennt |
