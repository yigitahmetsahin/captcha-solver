# Changelog

## [2.0.0](https://github.com/yigitahmetsahin/captcha-solver/compare/v1.2.1...v2.0.0) (2026-04-06)


### ⚠ BREAKING CHANGES

* solve() returns SolveResult instead of string. Access the answer via result.text.

### Features

* return SolveResult with token usage from solve() ([6b2c583](https://github.com/yigitahmetsahin/captcha-solver/commit/6b2c583390054c3a7b6bf8d7e72a1203c1812ea5))

## [1.2.1](https://github.com/yigitahmetsahin/captcha-solver/compare/v1.2.0...v1.2.1) (2026-04-06)


### Performance

* run voting attempts in parallel ([2ac900f](https://github.com/yigitahmetsahin/captcha-solver/commit/2ac900fe2cfec33443c950ffad81602b29db67a6))

## [1.2.0](https://github.com/yigitahmetsahin/captcha-solver/compare/v1.1.0...v1.2.0) (2026-04-06)


### Features

* replace OpenAI SDK with Vercel AI SDK for multi-provider support ([4e189ed](https://github.com/yigitahmetsahin/captcha-solver/commit/4e189ed9b99e26eccf58b6ab42fa263137bd5a34))


### Bug Fixes

* regenerate lockfile to fix npm ci in CI ([a193173](https://github.com/yigitahmetsahin/captcha-solver/commit/a193173dc53bd611b29b45891bbe3880a769193a))

## [1.1.0](https://github.com/yigitahmetsahin/captcha-solver/compare/v1.0.1...v1.1.0) (2026-04-06)


### Features

* replace Python/PIL preprocessing with pure JS (sharp) ([9dd8600](https://github.com/yigitahmetsahin/captcha-solver/commit/9dd8600bb121ef18447ff7d977917c2539d1f146))

## [1.0.1](https://github.com/yigitahmetsahin/captcha-solver/compare/v1.0.0...v1.0.1) (2026-04-05)


### Bug Fixes

* upgrade to Node 24 and sync lockfile ([5356e65](https://github.com/yigitahmetsahin/captcha-solver/commit/5356e6584c9f8a1c146ddd517fd7a249ed2c2ef3))
