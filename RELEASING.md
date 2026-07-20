# So veröffentlichst du ein neues Update

## Ein Befehl — fertig

Schreibe zuerst die Patchnotes in `RELEASE_NOTES.md` — sie werden der Text des GitHub-Releases. Danach tippe einfach:

```bash
npm run release
```

Das Script fragt dich, was für ein Update es ist (Bugfix, Feature, oder große Änderung), und erledigt dann alles automatisch:
- Baut das Plugin
- Zählt die Versionsnummer hoch (in allen 3 Dateien)
- Committet und pusht

GitHub erstellt danach automatisch den Release mit Release Notes und Sicherheitszertifikat. Deine Nutzer bekommen das Update innerhalb von 24h in Obsidian.

---

## Versionsnummern

Das Format ist `X.Y.Z`:
- **Bugfix** (Z): Kleine Korrekturen (z.B. 3.0.2 → 3.0.3)
- **Feature** (Y): Neue Funktionen (z.B. 3.0.2 → 3.1.0)
- **Große Änderung** (X): Nicht-kompatible Umbauten (z.B. 3.0.2 → 4.0.0)

---

## Häufige Fehler

| Problem | Lösung |
|---------|--------|
| Release wurde nicht erstellt | Prüfe ob `manifest.json` geändert und gepusht wurde |
| Nutzer sehen das Update nicht | Kann bis zu 24h dauern, bis Obsidian es erkennt |
| Release zeigt alte Patchnotes | `RELEASE_NOTES.md` vor dem Release aktualisieren |
