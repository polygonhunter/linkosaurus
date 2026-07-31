## 🦕 Housekeeping

A tidy-up pass after the plugin review — nothing you'll notice while writing, everything you'd want in the foundations.

- **Cleaner regex.** The ASCII fast-path check now uses `\p{ASCII}` instead of a control-character range. Same behaviour, no more raised eyebrows from linters.
- **Honest TypeScript config.** The project declared an older standard library than the code actually used, which made a handful of correctly-typed lines look unsafe to any tooling that didn't share our exact setup. The config now matches the build target.
- **No deprecated API calls.** The settings tab still renders the old way on Obsidian below 1.13 — that fallback just refreshes itself directly now, instead of going through an API Obsidian has since retired.

Linking, aliases, the `;;` search, and accent matching all behave exactly as before. Happy linking. 🦕
