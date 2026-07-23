## 🦕 The search gets right of way

Quick fix for a rough edge in yesterday's note search: the auto-linker was linking words *inside* your search.

Typing `;;Eibel - IT` used to fall apart at the first space — the auto-linker saw a finished word, turned it into `[[Eibel]]` mid-search, and the popup vanished with the `;;` left behind.

Now an active search owns its query. While you're typing after `;;`, the auto-linker stays quiet — spaces, separators and all — and the popup keeps filtering until you pick a note, press Esc, or move on. `;;Eibel - IT` → **Enter** → `[[Eibel - IT Termin]]`, exactly as intended.

Nothing else changed. Happy linking. 🦕
