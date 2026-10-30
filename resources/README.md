# Application resources

Resources are grouped by their consumer. Built-in plugin sources and their own
assets belong in `plugins/`; repository design documentation belongs in `docs/`.

| Path | Purpose |
| --- | --- |
| `icons/logo.png` | Source logo used by the Renderer and icon generation |
| `icons/png/` | Linux application icons, named by pixel dimensions |
| `icons/win/` | Windows application icon |
| `icons/mac/` | macOS application icon and unique source PNGs in `png/` |
| `icons/tray/` | Platform-specific tray and window icons |
| `pages/` | Development connection-error page and inert preference-import page |
| `python/` | Locked package requirements and embedded-Python `sitecustomize.py` |
| `mac/` | macOS signing entitlements |
| `licenses/` | Legal notices embedded in the Windows installer |
| `installer-clock/win-x86/` | Precompiled native NSIS clock and source-bound verification manifest |
| `pets/` | Pet sprites and animation metadata |
| `openclaw/docs/` | OpenClaw runtime documentation and role templates |
| `package-manager-config/` | Optional environment-specific npm and pip configuration |

Download destinations and preparation commands are maintained in
[offline downloads](../docs/offline-downloads.md). Retain the caches on offline
build hosts: preparation scripts reuse their versioned archives and licenses from
the repository-root `cache/`, grouped as `mingit/`, `python/`, `local-speech/` and
`drawio/`. Prepared runtime payloads live under `build/runtimes/`, grouped as
`mingit/`, `python-win/` and `local-tts/`.

Generated build artifacts are grouped under the repository-root `build/`:
`runtimes/` contains prepared runtimes, `tar/` contains Windows runtime archives,
`speech-models/v1/` contains published model artifacts, and `browser-extension/`
contains the assembled browser package and Native Messaging helper. Both
`build/` and `cache/` are ignored by Git.

Source layout and installed layout have explicit mappings. `icons/tray/` is
packaged into the installation resource directory as `tray/`; the native
`mingit/`, `python-win/` and `local-tts/` runtime names remain unchanged. Renderer
preferences are hydrated from Main KV without a file-origin import page.
The development error page is used only when
connecting to the local development server fails.

The macOS generator builds its temporary iconset from `icons/mac/png/<size>x<size>.png`.
Retina slots reuse the PNG at twice the slot size, so each source image is stored
once. Regenerating `.icns` requires macOS; the prepared icon remains checked in.
