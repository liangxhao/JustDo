# Speech protocol contracts

Pure request and response codecs for four OpenAI compatible speech contracts:
HTTP transcription and speech, realtime transcription and realtime conversation.
HTTP and WebSocket alone do not establish protocol compatibility.

Import the source entry at build time and inline it into the consuming artifact.
The module does not use a plugin framework, Node, DOM, network, files, credentials
or process state. Hosts own transport, authentication, proxy policy, admission,
cancellation, bounded response reads and request/configuration identity.

`buildTranscriptionRequest` returns a multipart description.
`buildSpeechRequest` returns a JSON body and expects bounded binary audio.
Hosts serialize these plans with their own transport APIs; codecs never initiate
a request. Streaming and voice cloning/design are separate workflows.

Legacy protocol defaults must be chosen by each consumer. Unknown explicit
protocols and removed configuration fields fail. Speech requires an explicit
preset voice; an empty voice never selects a service default.
