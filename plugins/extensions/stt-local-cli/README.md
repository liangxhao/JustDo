# stt-local-cli

Provides the `transcribe_audio` OpenClaw tool using the application's installed
Sherpa ONNX runtime and model. Configuration is synchronized by the host app.
No network API, model download, or cloud fallback is used during transcription.

Tool input: `{ "audio_path": "C:\\project\\meeting.mp3" }`.
Model assets must first be installed in voice settings. The microphone enable
switch is independent of this tool. The plugin can be disabled in Plugins.

The app currently provisions Windows x64 only. Audio is decoded by the pinned
platform FFmpeg package. Keep its executable, package metadata, and license files
when packaging; its path resolver is loaded lazily relative to the extension.
FFmpeg is a separate process and has its own license; see the installed platform
package's README/license for the build and upstream source information.

See `docs/architecture/07-plugin-system.md` in the application repository for
limits, attachment staging, permissions, cancellation, and lifecycle ownership.
