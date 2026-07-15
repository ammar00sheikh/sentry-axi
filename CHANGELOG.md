# Changelog

## [0.1.1](https://github.com/ammar00sheikh/sentry-axi/compare/sentry-axi-v0.1.0...sentry-axi-v0.1.1) (2026-07-15)


### Features

* add CLI dispatch, per-command help, and session hooks ([64f90d9](https://github.com/ammar00sheikh/sentry-axi/commit/64f90d9701eec1c7c9318bb3388e6abd17bda230))
* add issue triage commands and token-efficient rendering ([356ec4b](https://github.com/ammar00sheikh/sentry-axi/commit/356ec4bd8786fc2c2a3daa52ef7f148dd11f1a7c))
* add releases, deploys, suspect commits, and perf summaries ([def2f10](https://github.com/ammar00sheikh/sentry-axi/commit/def2f109cb9ef80d87ed01eb1e29c0b9449864db))
* add Seer AI root-cause analysis ([8278d5f](https://github.com/ammar00sheikh/sentry-axi/commit/8278d5f6cfa04b91ee94015b56bbc22265fad496))
* add Sentry API client with structured errors ([06709d4](https://github.com/ammar00sheikh/sentry-axi/commit/06709d4f99584bb2d51a4d9bfd0bdaab63343312))
* add uid ref registry with generation stamping ([080669c](https://github.com/ammar00sheikh/sentry-axi/commit/080669cc5efed3e8c48cca8a6f20c4d734ac84a4))
* **bench:** add the AXI-vs-MCP benchmark harness ([3b23778](https://github.com/ammar00sheikh/sentry-axi/commit/3b237780b170e3e1d62fec6eb153fa9810374e84))
* delegate sourcemap and debug-file uploads to sentry-cli ([d9a3a99](https://github.com/ammar00sheikh/sentry-axi/commit/d9a3a99a0b68207821bbff513be3c2aa6aca7a22))
* generate the installable agent skill from the CLI's own help ([8c6a7f1](https://github.com/ammar00sheikh/sentry-axi/commit/8c6a7f104b6cd6377841986aff29be7b74b06ecc))


### Bug Fixes

* **login:** store the instance URL with the token, for self-hosted Sentry ([b255d15](https://github.com/ammar00sheikh/sentry-axi/commit/b255d15d6c7081fa88c03e7a90590f9fda0055ce))
* never render an error with an empty help block ([c071527](https://github.com/ammar00sheikh/sentry-axi/commit/c0715271f00d0dcc3738780045dd1ecc655b4070))
* **seer:** report a disabled Seer as SEER_UNAVAILABLE, not AUTH_INVALID ([9b09560](https://github.com/ammar00sheikh/sentry-axi/commit/9b09560a25498fcd180de5136e4a24661225a616))
* **suggestions:** distinguish 'no match' from 'project has no events' ([f56767d](https://github.com/ammar00sheikh/sentry-axi/commit/f56767d94de53646328527855e985040c4033ee5))
* three bugs found by running against a live Sentry instance ([0c4ffae](https://github.com/ammar00sheikh/sentry-axi/commit/0c4ffae3b9dc9582b5b853bcf7bc1135f74ea6b3))

## Changelog
