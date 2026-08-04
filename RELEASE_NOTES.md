## 🦕 Mail gets the same treatment

URLs have been linking themselves for a while. Now email addresses do too.

```
Write to team@example.com  →  Write to [team@example.com](mailto:team@example.com)
```

Type an address, hit space — it becomes a clickable `mailto:` link with the address still spelled out in full. Pasted text gets the same pass.

- **No allowlist to maintain.** Bare web domains need their TLD on a list; addresses don't. The `@` is signal enough, so `name@company.fr` links exactly like `.com` does.
- **Good manners.** A sentence-ending `.` or `,` stays outside the link. Addresses already inside a link, a `mailto:` target, or a URL like `https://user@host.com` are left alone.
- **One toggle**, on by default: *Settings → Auto-link email addresses*.

### 🐛 And a fix worth having

Addresses used to get mangled. Because `@` is not a URL character, the URL matcher scanned backwards into an address and linked the domain half on its own:

```
Write to team@example.com  →  Write to team@[example.com](https://example.com)
```

That's gone — addresses are now recognised as addresses, and with email linking switched off they stay plain text instead of being broken apart.

Happy linking. 🦕
