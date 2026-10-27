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
`model`, and `speakerVoice`. `apiKey` is optional; native secret preparation must
resolve a SecretRef before execution. There is no environment credential lookup,
public endpoint default, local retry or alternate provider inside this extension.
Requests use the native HTTP and SSRF SDK with trust limited to the configured
origin, zero redirects, and a 50 MiB response limit. Online telephony is unsupported.

The application owns the native strict persona and isolated preference path that
prevent native TTS from falling back to another configured provider. Native TTS
does not supply an AbortSignal to speech providers; its configured timeout bounds
online synthesis.
