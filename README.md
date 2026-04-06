# @yigitahmetsahin/captcha-solver

AI-powered captcha solver using image preprocessing and vision models with parallel majority voting. Supports OpenAI, Anthropic, and Google providers via the Vercel AI SDK.

[![npm](https://img.shields.io/npm/v/@yigitahmetsahin/captcha-solver)](https://www.npmjs.com/package/@yigitahmetsahin/captcha-solver)
[![CI](https://github.com/yigitahmetsahin/captcha-solver/actions/workflows/ci.yml/badge.svg)](https://github.com/yigitahmetsahin/captcha-solver/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

## Features

- **AI Vision OCR** - Uses vision models (OpenAI, Anthropic, Google) to read distorted captcha text
- **Image Preprocessing** - Sharp/libvips pipeline: grayscale, blur, upscale, contrast/sharpness enhancement, cropping
- **Parallel Majority Voting** - Fires all attempts concurrently and uses character-level majority voting for accuracy
- **Multi-Provider** - Supports OpenAI, Anthropic, and Google via Vercel AI SDK
- **Configurable** - Adjustable provider, model, attempt count, expected length, and verbosity
- **TypeScript** - Full type safety with strict mode

## Prerequisites

- Node.js >= 18
- An API key for at least one supported provider (OpenAI, Anthropic, or Google)

## Installation

```bash
npm install @yigitahmetsahin/captcha-solver
```

## Quick Start

```typescript
import 'dotenv/config';
import { Solver } from '@yigitahmetsahin/captcha-solver';

const solver = new Solver(process.env.OPENAI_API_KEY!);
const { text, attempts, usage } = await solver.solve('./captcha.png', {
  numAttempts: 5,
  expectedLength: 4,
});

console.log('Captcha answer:', text);
console.log('Attempts:', attempts);
console.log('Total tokens:', usage.totalTokens);
```

## API

### `solver.solve(input, options?)`

Solve a captcha image using AI vision + preprocessing + parallel majority voting.

**Parameters:**

| Option           | Type      | Default    | Description                                     |
| ---------------- | --------- | ---------- | ----------------------------------------------- |
| `model`          | `string`  | `'gpt-4o'` | Model ID passed to the provider                 |
| `numAttempts`    | `number`  | `5`        | Number of parallel voting attempts              |
| `expectedLength` | `number`  | -          | Expected captcha length (filters wrong lengths) |
| `maxRetries`     | `number`  | `2`        | Max retries per attempt on API failure          |
| `verbose`        | `boolean` | `true`     | Whether to log attempt details                  |

**Returns:** `Promise<SolveResult>`

```typescript
interface SolveResult {
  text: string; // Majority-voted captcha answer
  attempts: string[]; // Per-attempt raw answers
  usage: LanguageModelUsage; // Aggregated token usage
  attemptUsages: LanguageModelUsage[]; // Per-attempt token usage
}
```

### `preprocessCaptcha(imagePath)`

Preprocess a captcha image for better OCR accuracy. Returns base64-encoded PNG.

### `imageToBase64(imagePath)`

Read an image file and return its base64-encoded content.

## CLI Usage

```bash
# Solve a single captcha
npm run solve -- path/to/captcha.png

# Solve with a specific model
npm run solve -- path/to/captcha.png --model gpt-4o

# Run benchmark (20 iterations)
npm run benchmark
```

## How It Works

1. **Preprocessing** - The image is processed through a sharp (libvips) pipeline:
   - Convert to grayscale
   - Apply Gaussian blur to smooth noise
   - Upscale 4x with Lanczos interpolation
   - Enhance contrast (3x) and sharpness (2x)
   - Crop decorative borders
   - Add white padding

2. **Parallel Attempts** - The preprocessed image is sent to the vision API concurrently across all attempts (via `Promise.all`) with temperature=1 for diverse responses.

3. **Majority Voting** - Character-level majority voting across all parallel attempts determines the final answer, filtering by expected length if specified.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Lint + format + type-check
npm run lint

# Build
npm run build
```

## License

MIT
