#!/bin/bash
set -e

# Current version from manifest.json
CURRENT=$(node -p "require('./manifest.json').version")

# Parse current version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

echo ""
echo "  Aktuelle Version: $CURRENT"
echo ""
echo "  Was für ein Update ist das?"
echo ""
echo "    1) Bugfix        → $MAJOR.$MINOR.$((PATCH + 1))"
echo "    2) Neues Feature → $MAJOR.$((MINOR + 1)).0"
echo "    3) Große Änderung → $((MAJOR + 1)).0.0"
echo ""
read -p "  Auswahl (1/2/3): " CHOICE

case $CHOICE in
  1) NEW="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  2) NEW="$MAJOR.$((MINOR + 1)).0" ;;
  3) NEW="$((MAJOR + 1)).0.0" ;;
  *) echo "  Ungültige Auswahl."; exit 1 ;;
esac

echo ""
echo "  Neue Version: $NEW"
echo ""
read -p "  Weiter? (j/n): " CONFIRM
if [ "$CONFIRM" != "j" ]; then
  echo "  Abgebrochen."
  exit 0
fi

echo ""
echo "  → Plugin bauen..."
npm run build

echo "  → Versionsnummern aktualisieren..."

# manifest.json
node -e "
const f = require('fs');
const m = JSON.parse(f.readFileSync('manifest.json', 'utf8'));
m.version = '$NEW';
f.writeFileSync('manifest.json', JSON.stringify(m, null, '\t') + '\n');
"

# package.json
node -e "
const f = require('fs');
const p = JSON.parse(f.readFileSync('package.json', 'utf8'));
p.version = '$NEW';
f.writeFileSync('package.json', JSON.stringify(p, null, '\t') + '\n');
"

# versions.json
node -e "
const f = require('fs');
const v = JSON.parse(f.readFileSync('versions.json', 'utf8'));
const minApp = require('./manifest.json').minAppVersion;
const updated = { '$NEW': minApp };
for (const [k, val] of Object.entries(v)) updated[k] = val;
f.writeFileSync('versions.json', JSON.stringify(updated, null, '\t') + '\n');
"

echo "  → Committen und pushen..."
git add main.js manifest.json package.json versions.json
git commit -m "Release $NEW"
git push

echo ""
echo "  ✅ Version $NEW veröffentlicht!"
echo ""
echo "  GitHub erstellt jetzt automatisch den Release."
echo "  Deine Nutzer bekommen das Update innerhalb von 24h in Obsidian."
echo ""
