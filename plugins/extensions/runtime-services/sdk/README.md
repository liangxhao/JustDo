# Runtime Services SDK

`@runtime-services/sdk` provides versioned client contracts for Runtime Services. Install its compiled npm package and consume the exports in [package.json](package.json).

Pure contracts and parsers can be used in Browser or presentation code; filesystem access, native clients and owner-proof helpers require Node. Business schemas remain in their consuming plugins.

Native clients require an authenticated, compatible Runtime Services instance and the current native registration. Read tokens do not grant write access; managed execution retains the caller's own executor and requires exact whole-run settlement and cleanup evidence. Unknown sends are never replayed automatically.

Installing this SDK or App Plugin SDK does not install, start or authorize Runtime Services.
