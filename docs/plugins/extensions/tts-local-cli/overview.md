# Configured speech provider

This version-locked source replacement retains the native `tts-local-cli` plugin
and provider identities. Plugin enable/deny policy therefore covers both the local
CLI and configured online service. The application projects the selected model
into `tts.providers["tts-local-cli"]`; this extension does not select models or
download assets.

Local configuration uses the native `command`, `args`, `outputFormat`, `timeoutMs`,
`cwd` and `env` contract. `cli-speech-provider.ts` preserves the complete upstream
2026.10.7 implementation, except that task text previews are not logged. See
`upstream-source.json` for original file hashes and `LICENSE` for its MIT license.

Online configuration requires `mode: "online"`, an explicit HTTP(S) `baseUrl`,
`model`, the standard Speech protocol and structured `voiceSelection`. It delegates
to the registered OpenAI speech provider through the public provider registry.
An explicit voice ID is required; `speakerVoice` is retained for valid legacy
configuration. Retired protocols, compatibility fields and default-voice selections
are rejected rather than converted to a supported request. `apiKey` is optional and native
secret preparation must resolve a SecretRef before execution. There is no
environment credential lookup, public endpoint default, local retry or alternate
provider. The delegated transport limits trust to the configured origin, rejects
redirects and buffers a bounded complete response. Online telephony, SSE playback
and voice cloning/design are unsupported.

The application owns the native strict persona and isolated preference path that
prevent native TTS from falling back to another configured provider. Native TTS
does not supply an AbortSignal to speech providers; its configured timeout bounds
online synthesis.

## Contract and validation

See the [execution and host integration contract](synthesis.md).
