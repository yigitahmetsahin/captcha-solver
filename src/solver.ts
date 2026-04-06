import type { LanguageModel } from 'ai';
import { generateText } from 'ai';
import { preprocessCaptchaToBuffer } from './preprocess.js';

const PROMPT = `You are an assistant helping a visually impaired person read distorted text from an image.
The text contains uppercase letters A-Z and/or digits 0-9.
A thin vertical stroke is the digit 1. Never read it as the letter I or L.
A round closed shape is the letter O, not the letter D.
Output ONLY the exact characters you read, nothing else.`;

// ── Types ────────────────────────────────────────────────────────────

export type Provider = 'openai' | 'anthropic' | 'google';

export interface SolverOptions {
  /** AI provider to use when constructing the model from an API key (default: "openai") */
  provider?: Provider;
  /** Model ID passed to the provider (default: "gpt-4o") */
  model?: string;
}

export interface SolveOptions {
  /** Number of voting attempts (default: 5) */
  numAttempts?: number;
  /** Expected captcha length — results of other lengths are discarded */
  expectedLength?: number;
  /** Max retries per attempt on API failure (default: 2) */
  maxRetries?: number;
  /** Whether to log attempt details (default: true) */
  verbose?: boolean;
}

// ── Provider resolution ──────────────────────────────────────────────

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  google: 'gemini-2.0-flash',
};

async function resolveModel(
  apiKey: string,
  provider: Provider,
  modelId: string
): Promise<LanguageModel> {
  switch (provider) {
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey })(modelId);
    }
    case 'anthropic': {
      // @ts-expect-error — optional peer dependency
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ apiKey })(modelId);
    }
    case 'google': {
      // @ts-expect-error — optional peer dependency
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ apiKey })(modelId);
    }
    default:
      throw new Error(
        `Unknown provider "${provider}". Install the matching @ai-sdk/* package and pass the model directly.`
      );
  }
}

// ── Confusion groups ─────────────────────────────────────────────────

/**
 * Characters the model commonly misreads as each other.
 * Each group maps to its canonical (most likely correct) character.
 */
const CONFUSION_GROUPS: Record<string, string> = {
  '1': '1',
  I: '1',
  L: '1',
  O: 'O',
  D: 'O',
  '0': 'O',
  S: 'S',
  '5': 'S',
  Z: 'Z',
  '2': 'Z',
};

// ── Majority voting ──────────────────────────────────────────────────

/**
 * Character-level majority vote across multiple attempts.
 * Uses confusion-aware voting: characters that the model commonly
 * confuses (e.g. 1/I/L, O/D/0) are grouped together during counting.
 */
function majorityVote(attempts: string[], expectedLength?: number): string {
  let filtered = expectedLength ? attempts.filter((a) => a.length === expectedLength) : attempts;

  if (filtered.length === 0) {
    filtered = attempts;
  }
  if (filtered.length === 0) return '';

  // Find most common length
  const lenCounts = new Map<number, number>();
  for (const a of filtered) {
    lenCounts.set(a.length, (lenCounts.get(a.length) ?? 0) + 1);
  }
  let bestLen = 0;
  let bestCount = 0;
  for (const [len, count] of lenCounts) {
    if (count > bestCount) {
      bestLen = len;
      bestCount = count;
    }
  }

  const sameLenAttempts = filtered.filter((a) => a.length === bestLen);
  if (sameLenAttempts.length === 0) return filtered[0];

  // Vote per character position with confusion-aware grouping
  const result: string[] = [];
  for (let pos = 0; pos < bestLen; pos++) {
    const charCounts = new Map<string, number>();
    for (const a of sameLenAttempts) {
      const ch = a[pos];
      charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
    }

    const groupCounts = new Map<string, number>();
    for (const [ch, count] of charCounts) {
      const canonical = CONFUSION_GROUPS[ch] ?? ch;
      groupCounts.set(canonical, (groupCounts.get(canonical) ?? 0) + count);
    }

    let bestGroup = '';
    let bestGroupCount = 0;
    for (const [canonical, count] of groupCounts) {
      if (count > bestGroupCount) {
        bestGroup = canonical;
        bestGroupCount = count;
      }
    }

    result.push(bestGroup);
  }

  return result.join('');
}

// ── Solver class ─────────────────────────────────────────────────────

export class Solver {
  private _model: LanguageModel | null = null;
  private _pendingModel: Promise<LanguageModel> | null = null;

  /**
   * Create a captcha solver.
   *
   * @example
   * // Simple — defaults to OpenAI gpt-4o
   * const solver = new Solver('sk-...');
   *
   * @example
   * // Specify provider and model
   * const solver = new Solver('sk-ant-...', { provider: 'anthropic', model: 'claude-sonnet-4-20250514' });
   *
   * @example
   * // Pass an AI SDK model directly
   * import { createOpenAI } from '@ai-sdk/openai';
   * const openai = createOpenAI({ apiKey: 'sk-...' });
   * const solver = new Solver(openai('gpt-4o'));
   */
  constructor(keyOrModel: string | LanguageModel, options?: SolverOptions) {
    if (typeof keyOrModel === 'string') {
      const provider = options?.provider ?? 'openai';
      const modelId = options?.model ?? DEFAULT_MODELS[provider];
      // Lazily resolve the model on first use
      this._pendingModel = resolveModel(keyOrModel, provider, modelId);
    } else {
      this._model = keyOrModel;
    }
  }

  private async getModel(): Promise<LanguageModel> {
    if (this._model) return this._model;
    this._model = await this._pendingModel!;
    this._pendingModel = null;
    return this._model;
  }

  /**
   * Solve a captcha image.
   *
   * @param input - File path (string) or raw image Buffer
   * @param options - Solve options (attempts, expected length, etc.)
   * @returns The captcha text
   */
  async solve(input: string | Buffer, options: SolveOptions = {}): Promise<string> {
    const { numAttempts = 5, expectedLength, maxRetries = 2, verbose = true } = options;

    const model = await this.getModel();
    const imageBuffer = await preprocessCaptchaToBuffer(input);

    // Fire all attempts in parallel for speed
    const results = await Promise.all(
      Array.from({ length: numAttempts }, () => this.singleAttempt(model, imageBuffer, maxRetries))
    );
    const attempts = results.filter((r): r is string => r !== null);
    if (verbose) {
      attempts.forEach((r, i) => console.log(`  Attempt ${i + 1}: ${r}`));
    }

    if (attempts.length === 0) {
      if (verbose) console.log('  All attempts failed!');
      return '';
    }

    return majorityVote(attempts, expectedLength);
  }

  /**
   * Make a single API call to read the captcha.
   * Retries up to `maxRetries` times on failure.
   */
  private async singleAttempt(
    model: LanguageModel,
    imageBuffer: Buffer,
    maxRetries: number
  ): Promise<string | null> {
    for (let retry = 0; retry <= maxRetries; retry++) {
      try {
        const { text } = await generateText({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: PROMPT },
                { type: 'image', image: imageBuffer },
              ],
            },
          ],
          temperature: 1,
          maxOutputTokens: 256,
        });

        const raw = text.trim();

        // Detect refusals
        const lower = raw.toLowerCase();
        if (
          lower.includes('sorry') ||
          lower.includes("can't help") ||
          lower.includes('cannot help') ||
          lower.includes('unable to') ||
          lower.includes("i can't") ||
          raw.length > 20
        ) {
          return null;
        }

        // Clean: keep only uppercase letters and digits
        const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
        return cleaned || null;
      } catch (_err) {
        if (retry < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
          continue;
        }
        return null;
      }
    }
    return null;
  }
}
