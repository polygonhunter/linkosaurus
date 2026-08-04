## 🦕 Properties, now actually working

4.3.0 promised that property values would link themselves. In practice they mostly didn't, and that's on me. Three things stood in the way:

- **The work was thrown away.** Obsidian saves a property the moment you move to the *next* field — so the linking was queued while the cursor was still in the property panel, and the check for "is someone typing right now?" answered yes and dropped it. Nothing ever picked it up again. Now it waits instead of giving up, and links as soon as you leave the panel or switch notes.
- **The default list was too narrow.** It shipped with `author`, `publisher`, `related`, `topic`, `people`, `project` — so real vaults with `company` or `attendees` linked nothing at all. Every property is now fair game (except `tags`, `aliases` and `cssclasses`, which never were). If you still have the old list and never changed it, it's cleared for you; a list you edited yourself stays put.
- **It was off by default.** Now on, because it can only ever touch the note you have open — a sync or another plugin can't set off a chain of edits across your vault. Not for you? *Settings → Link property values*.

So the thing from the bug report works now:

```
company: Museum   →  leave the field  →  company: "[[Museum of Natural History]]"
```

The command *Link property values in current note* also explains itself when nothing happens — whether the note has no properties, none of them are on your list, or no value matched a note.

Happy linking. 🦕
