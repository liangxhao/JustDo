# App Plugin SDK

`@app-plugin/sdk` defines public Native, Main, Browser and presentation contracts for trusted app companions.

Use Node 24 and install a compatible SDK, `@app-plugin/build` and the plugin's declared dependencies. Browser artifacts share the host's React/ReactDOM instance and must satisfy this package's peer dependencies.

Import public npm exports such as `@app-plugin/sdk/main`, `@app-plugin/sdk/browser` and `@app-plugin/sdk/contracts`. The export map and dependency ranges are declared in [package.json](package.json).

Native, Main and Browser entries are separate artifacts. A companion declares its capabilities, commands and slots in its manifest; the host validates them and withdraws stale callbacks when its lifetime ends. Do not import application source or create a transcript cache.

Main `onEnable(resources)` and Browser `host.resources` provide local resource scopes for listeners, timers and cooperative tasks. Dispose component child scopes during effect cleanup. These helpers manage local lifetimes; they do not grant native execution authority or prove task completion.

Installing the SDK does not install a plugin or provide Runtime Services. Managed execution requires a compatible, explicitly admitted runtime. Main and Browser modules run trusted code; the SDK is not a hostile-code sandbox.
