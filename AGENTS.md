# AGENTS.md

## Project Overview

An AI-powered captcha solver library using image preprocessing and vision models (OpenAI, Anthropic, Google via Vercel AI SDK). Supports parallel majority voting across concurrent attempts for high accuracy. Published to npm as `@yigitahmetsahin/captcha-solver`.

## Setup Commands

```bash
# Install dependencies
npm install

# Build the library
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Lint, format, and type-check (auto-fixes issues)
npm run lint

# Check only (no auto-fix, used in CI)
npm run lint:check

# Solve a captcha image
npm run solve -- path/to/image.png

# Run benchmarks
npm run benchmark
```

## Code Style

- TypeScript strict mode enabled
- Prefer async/await over raw promises
- Keep functions focused on a single responsibility
- Use descriptive names

## Project Structure

```
src/
├── index.ts          # Public exports
├── solver.ts         # Captcha solving with AI vision + parallel majority voting
└── preprocess.ts     # Image preprocessing via sharp (libvips)
run.ts                # CLI runner (solve + benchmark modes)
```

## Testing Instructions

- Run `npm test` before committing any changes
- All tests must pass before merging
- Add tests for any new features or bug fixes
- Tests use Vitest framework

### Test-Driven Development (TDD)

**Always use TDD when implementing new features or fixing bugs:**

1. **Write tests first** - Write tests that define the expected behavior before writing implementation code
2. **Run tests to see them fail** - Verify the tests fail as expected (red phase)
3. **Implement the feature** - Write the minimum code needed to make tests pass (green phase)
4. **Refactor if needed** - Clean up the code while keeping tests passing (refactor phase)

## Pre-Commit Checklist

Before committing any changes, **ALWAYS run**:

```bash
npm run lint
```

This automatically:

1. Formats all files with Prettier
2. Fixes ESLint issues
3. Runs TypeScript type checking

All errors must be resolved before committing.

## Editor Setup

This project includes VS Code settings (`.vscode/settings.json`) that:

- Auto-format on save with Prettier
- Auto-fix ESLint issues on save

Install the [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) and [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) VS Code extensions for the best experience.

## Build System

- Uses `tsup` for building ESM, CJS, and DTS outputs
- Output goes to `dist/` folder
- Build command: `npm run build`

## Release Process (Automated)

This project uses **Release Please** bot for automated releases:

1. Use conventional commits:
   - `feat:` -> minor version bump (new features)
   - `fix:` -> patch version bump (bug fixes)
   - `feat!:` or `BREAKING CHANGE:` -> major version bump
   - `docs:`, `chore:`, `refactor:` -> no release

2. Bot automatically opens/updates a release PR on each push to main

3. Merging the release PR:
   - Generates GitHub release with auto-generated changelog
   - Publishes to npm with OIDC provenance

## Commit Message Format

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Examples:

- `feat: add retry mechanism for failed attempts`
- `fix: handle null values in preprocessing`
- `docs: update README with new examples`

## Documentation & Testing Requirements

When making code changes, **ALWAYS keep the following up to date**:

1. **Unit Tests** (`src/*.test.ts`)
   - Add tests for new features or bug fixes
   - Update existing tests when API changes

2. **Documentation**
   - `README.md` - User-facing documentation and API examples
   - `AGENTS.md` - Developer/agent instructions

Documentation, tests, and examples should be updated **in the same PR** as the code changes, not as a follow-up.

## Branching Policy

**CRITICAL: ALWAYS start a NEW branch from `main` for EVERY change.** Never reuse or add commits to an existing branch, even if it seems related. Each task/fix/feature gets its own fresh branch.

- **Each feature or fix requires a separate branch** - never push multiple unrelated changes to the same branch
- **NEVER use an existing branch** - always run `git checkout main && git pull && git checkout -b <new-branch>` before starting any work
- Branch naming convention:
  - Features: `feat/<short-description>` (e.g., `feat/retry-mechanism`)
  - Bug fixes: `fix/<short-description>` (e.g., `fix/null-handling`)
  - Refactors: `refactor/<short-description>`
  - Docs: `docs/<short-description>` (e.g., `docs/update-readme`)
- **One PR per feature/fix** - do not combine unrelated changes in a single PR
- Always start branches from the latest `main`
- After a PR is merged, start a new branch for the next change - do not reuse merged branches

## Important Notes

- Do NOT manually bump version in `package.json` - Release Please handles this
- Do NOT make tags manually - Release Please handles them
- The `dist/` folder is gitignored but included in npm package
- npm publishing uses GitHub OIDC trusted publishing (no tokens needed)
- **ALWAYS run `npm install` after adding/updating dependencies** to update `package-lock.json`
- Image preprocessing uses sharp (libvips) — no Python dependency needed
