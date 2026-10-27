# stt-local-cli

Provides the `transcribe_audio` OpenClaw tool using the model selected in plugin
settings. Configuration is synchronized by the host app with an explicit
`mode: "local"` or `mode: "online"`. Local mode uses the installed Sherpa ONNX
runtime and model. Online mode requires an explicit HTTP(S) `baseUrl`, `model`,
and `language`; `apiKey` is optional and SecretRefs must be prepared by the native
host. Online requests upload decoded 30-second PCM segments through the native
HTTP/SSRF SDK, trust only the configured origin, and reject redirects. There is
no environment credential lookup, public endpoint default or alternate model
fallback. A failed segment fails the complete transcription without a retry.

Tool input: `{ "audio_path": "C:\\project\\meeting.mp3" }`.
Local model assets must first be installed in model settings. The microphone enable
switch is independent of this tool. The plugin can be disabled in Plugins.

The app currently provisions Windows x64 only. Audio is decoded by the pinned
platform FFmpeg package. Keep its executable, package metadata, and license files
when packaging; its path resolver is loaded lazily relative to the extension.
FFmpeg is a separate process and has its own license; see the installed platform
package's README/license for the build and upstream source information.

See `docs/architecture/07-plugin-system.md` in the application repository for
limits, attachment staging, permissions, cancellation, and lifecycle ownership.
