## 🦕 The search comes to your properties

Type `;;` in a property field and the search popup appears — the same one you know from the note body.

```
company: ;;Mus▌
┌────────────────────────────────┐
│ 🔗 Museum of Natural History   │
└────────────────────────────────┘
```

Arrow keys to choose, Enter to pick, and the finished link lands in the field. Same trigger, same fuzzy matching over your note names, keywords and aliases. It works in text properties and in list properties alike.

### 📌 A correction

Previous release notes claimed a popup inside a property field was impossible because those fields sit outside the note editor. The first half is true — the editor-bound suggestion API really doesn't reach them. But Obsidian has a second one built exactly for input fields, and it works there. I was wrong, and the docs saying otherwise have been fixed.

Writing a name plainly and leaving the field still links it, as before. The popup is simply the faster way when you don't remember the full name.

Happy linking. 🦕
