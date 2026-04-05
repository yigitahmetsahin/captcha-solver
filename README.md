# captcha-solver

AI-powered captcha solver using image preprocessing and OpenAI vision models with majority voting.

[![CI](https://github.com/yigitahmetsahin/captcha-solver/actions/workflows/ci.yml/badge.svg)](https://github.com/yigitahmetsahin/captcha-solver/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

## Features

- **AI Vision OCR** - Uses OpenAI vision models (o3, gpt-4o, etc.) to read distorted captcha text
- **Image Preprocessing** - PIL-based pipeline: grayscale, blur, upscale, contrast/sharpness enhancement, cropping
- **Majority Voting** - Runs multiple attempts and uses character-level majority voting for accuracy
- **Configurable** - Adjustable model, attempt count, expected length, and verbosity
- **TypeScript** - Full type safety with strict mode

## Prerequisites

- Node.js >= 18
- Python 3 with PIL/Pillow (`pip install Pillow`)
- OpenAI API key

## Installation

```bash
npm install captcha-solver
```

## Quick Start

```typescript
import 'dotenv/config';
import { solveCaptchaImage } from 'captcha-solver';

const answer = await solveCaptchaImage('./captcha.png', {
  numAttempts: 5,
  expectedLength: 4,
  model: 'o3',
});

console.log('Captcha answer:', answer);
```

## API

### `solveCaptchaImage(imagePath, options?)`

Solve a captcha image using OpenAI vision + preprocessing + majority voting.

**Parameters:**

| Option           | Type      | Default | Description                                     |
| ---------------- | --------- | ------- | ----------------------------------------------- |
| `model`          | `string`  | `'o3'`  | OpenAI model to use                             |
| `numAttempts`    | `number`  | `5`     | Number of voting attempts                       |
| `expectedLength` | `number`  | -       | Expected captcha length (filters wrong lengths) |
| `maxRetries`     | `number`  | `2`     | Max retries per attempt on API failure          |
| `verbose`        | `boolean` | `true`  | Whether to log attempt details                  |

**Returns:** `Promise<string>` - The solved captcha text.

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

1. **Preprocessing** - The image is processed through a PIL pipeline:
   - Convert to grayscale
   - Apply Gaussian blur to smooth noise
   - Upscale 4x with Lanczos interpolation
   - Enhance contrast (3x) and sharpness (2x)
   - Crop decorative borders
   - Add white padding

2. **Multiple Attempts** - The preprocessed image is sent to OpenAI's vision API multiple times with temperature=1 for diverse responses.

3. **Majority Voting** - Character-level majority voting across all attempts determines the final answer, filtering by expected length if specified.

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
