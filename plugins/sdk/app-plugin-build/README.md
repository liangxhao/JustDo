# App plugin build tools

`@app-plugin/build` checks and packages a native OpenClaw extension with its trusted desktop app companion. Install compatible `@app-plugin/sdk`, declared plugin dependencies and matching public OpenClaw declarations; use the Node version in [package.json](package.json).

```sh
app-plugin-build check --source ./example-plugin --sdk-root /prepared/openclaw/dist/plugin-sdk
app-plugin-build build --source ./example-plugin --out ./build/app-plugins
```

`OPENCLAW_SDK_ROOT` can supply the declaration root instead. The complete installable extension is emitted under `packages/<id>/<hash>` in the output directory. Install the complete package through extension management.

Public exports include `theme-preset`, `testing` and `sdk` for theme composition, caller-supplied test ports and SDK publication. Builds use installed public dependencies; they do not read application source, download a runtime or authorize execution.
