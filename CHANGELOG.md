# Changelog

## [3.0.0](https://github.com/yigitahmetsahin/captcha-solver/compare/v2.0.1...v3.0.0) (2026-04-06)


### ⚠ BREAKING CHANGES

* confusion groups disabled by default, crop mode changed from fixed percentages to auto-detect. Use { confusionGroups: LEGACY_CONFUSION_GROUPS, preprocess: { crop: 'legacy' } } to restore old behavior.

### Features

* adaptive preprocessing and optional confusion groups ([8a1e597](https://github.com/yigitahmetsahin/captcha-solver/commit/8a1e597cd798ba7c5c2ec362eaef7813ede1db7d))
* dual-image solver with case-aware prompt (0% → 100% on external captchas) ([c2fa2d4](https://github.com/yigitahmetsahin/captcha-solver/commit/c2fa2d426fe4a6485359ed1a531daa6228d53902))


### Bug Fixes

* regenerate package-lock.json with resolved emnapi deps ([b50ef8e](https://github.com/yigitahmetsahin/captcha-solver/commit/b50ef8e9aee3e3cf8c76410aa83d53f03ce07b34))

## [2.0.1](https://github.com/yigitahmetsahin/captcha-solver/compare/v2.0.0...v2.0.1) (2026-04-06)


### Bug Fixes

* track test-captcha.png in repo and use it as default in run.ts ([57009eb](https://github.com/yigitahmetsahin/captcha-solver/commit/57009eb70f1d65a3bcb556e092d77f6f1c4bac47))

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
