## 🦕 No settings required

Property linking was supposed to just work after 4.3.1. For anyone who had already installed 4.3.0, it didn't — and the reason is a plain oversight on my part.

Saved settings always win over new defaults. Since 4.3.0 shipped the feature switched **off**, every vault that tried it back then carries that "off" in its settings file, and 4.3.1's new default never reached it. The people most likely to want the feature were exactly the ones it stayed broken for.

4.3.2 fixes that: settings written before this release get their property options put back to the defaults, once — switched on, every property included. After that, nothing needs touching. Type a value, leave the field, the link is there.

If you deliberately switch property linking off from now on, it stays off. This is a one-time correction for settings that were saved while the feature never worked.

Happy linking. 🦕
