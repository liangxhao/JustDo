# TypeSafe AI for OpenClaw

Official external plugin for typed decisions with hosted TypeSafe AI Jev models
or a local Kev System One server.
It provides Choice, Score, and Boolean judgments through OpenClaw's shared
decision-model API. Core supplies the provider-neutral `decision_evaluate` agent
tool when the agent has an effective `decisionModel` selection, subject to normal
tool policy and harness capabilities. No separate tool enablement is required.

Compatibility and the required plugin API are declared in [package.json](../../../../plugins/extensions/typesafe/package.json).
This source fork is supplied as a local package by its integrating host; it does not
require an unpublished registry package or a runtime download. The host must provide
a matching OpenClaw SDK and the locked production dependencies.

Enable the plugin, configure a protected TypeSafe credential and an explicit
`serviceUrl`, and select a declared TypeSafe `decisionModel` such as
`typesafe/jev-latest`. Evaluation sends the supplied evidence to that service;
usage and data handling follow the selected service's terms.

See [decision evaluation](decision-evaluation.md) for endpoint configuration,
admission, errors, secret-state ownership and validation boundaries.

For local Kev, configure `plugins.entries.typesafe.config.baseUrl` with the
server's loopback origin, such as `http://127.0.0.1:8009`, omit `apiKey`, and select
`typesafe/kev-latest`. The plugin calls `/v1/systemone` without a hosted credential.
Start the server separately with your chosen checkpoint; the decision-model
selection labels requests and does not download or load a model.
