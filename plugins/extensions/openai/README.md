# Configured OpenAI provider extension

This package contains the version-locked OpenClaw OpenAI extension and its local
explicit-endpoint adaptations. Source identity and original file hashes are recorded
in [upstream-source.json](upstream-source.json). Registration and configuration
capabilities are declared by [openclaw.plugin.json](openclaw.plugin.json) and
[index.ts](index.ts).

The integrating host supplies the matching native SDK, prepared SecretRefs and
explicitly configured services. A missing endpoint is not permission to use a public
service, a different configured model or an environment credential. The distributed
package must contain its required assets and production dependencies.

Speech supports explicit `openai-speech-http` requests with bounded binary audio.
Voice selection requires an explicit preset. Unknown protocols, removed
configuration fields and unsupported voice workflows fail.
Native managed HTTP policy bounds responses and rejects redirects or uncertain
submission retries; stopping playback does not prove remote synthesis was cancelled.

Plugin-owned `config.transcription` and `config.realtimeVoice` independently admit
realtime transcription and realtime conversation. The latter requires an explicit
endpoint, model, voice and input transcription model, and uses Gateway relay with
mono PCM16 at 24 kHz and assistant delegation. Missing or withdrawn profiles do not
borrow other configurations. Realtime conversation uses VAD without URL queries,
automatic reconnect, browser fallback, manual audio commit or session resumption.

This documentation does not claim that configuration tests validate real devices,
service availability or every provider capability. Those require separate host and
service acceptance.
