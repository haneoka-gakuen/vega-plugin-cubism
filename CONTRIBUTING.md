# Contributing

Use Node.js 20 or newer and pnpm 11. Run `pnpm check` before opening a change.
Keep adapters renderer-neutral and cancellation-safe, and add tests for every
lifecycle or parameter-mapping change.

This repository must remain code-only. Do not commit or generate Cubism SDK or
Core files, MotionSync components, native runtime binaries, models, textures,
motions, physics data, extracted game content, or credentials.

Maintainers publish from GitHub releases through npm trusted publishing. The
npm package must authorize this repository's `.github/workflows/publish.yml`
workflow before the first release.
