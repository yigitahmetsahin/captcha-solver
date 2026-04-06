import type { LanguageModel, LanguageModelUsage } from 'ai';
import { generateText } from 'ai';
import type { PreprocessOptions } from './preprocess.js';
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
  /**
   * Confusion groups for majority voting.
   * Pass a Record<string, string> to merge visually similar characters,
   * or `false` to disable (default: false).
   * Use LEGACY_CONFUSION_GROUPS to restore pre-3.0 behavior.
   */
  confusionGroups?: Record<string, string> | false;
  /** Preprocessing options passed to the image pipeline */
  preprocess?: PreprocessOptions;
}

export interface SolveResult {
  /** The solved captcha text (majority-voted) */
  text: string;
  /** Per-attempt raw answers (before voting) */
  attempts: string[];
  /** Aggregated token usage across all parallel attempts */
  usage: LanguageModelUsage;
  /** Per-attempt usage breakdown */
  attemptUsages: LanguageModelUsage[];
}

interface AttemptResult {
  text: string;
  usage: LanguageModelUsage;
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
 * Pre-3.0 confusion groups that merge visually similar characters.
 * Opt-in via `{ confusionGroups: LEGACY_CONFUSION_GROUPS }`.
 *
 * Maps: 1/I/L → '1', O/D/0 → 'O', S/5 → 'S', Z/2 → 'Z'
 */
export const LEGACY_CONFUSION_GROUPS: Record<string, string> = {
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
 * When `groups` is provided, visually similar characters are merged
 * during counting (e.g. 1/I/L all count toward '1').
 */
export function majorityVote(
  attempts: string[],
  expectedLength?: number,
  groups?: Record<string, string> | false
): string {
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

  const useGroups = groups && typeof groups === 'object' ? groups : undefined;

  // Vote per character position
  const result: string[] = [];
  for (let pos = 0; pos < bestLen; pos++) {
    const charCounts = new Map<string, number>();
    for (const a of sameLenAttempts) {
      const ch = a[pos];
      charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
    }

    if (useGroups) {
      // Confusion-aware voting
      const groupCounts = new Map<string, number>();
      for (const [ch, count] of charCounts) {
        const canonical = useGroups[ch] ?? ch;
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
    } else {
      // Simple majority — pick the most frequent raw character
      let bestChar = '';
      let bestCharCount = 0;
      for (const [ch, count] of charCounts) {
        if (count > bestCharCount) {
          bestChar = ch;
          bestCharCount = count;
        }
      }
      result.push(bestChar);
    }
  }

  return result.join('');
}

// ── Usage aggregation ────────────────────────────────────────────────

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function aggregateUsage(usages: LanguageModelUsage[]): LanguageModelUsage {
  const zero: LanguageModelUsage = {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens: undefined,
  };
  return usages.reduce<LanguageModelUsage>(
    (acc, u) => ({
      inputTokens: sumOptional(acc.inputTokens, u.inputTokens),
      inputTokenDetails: {
        noCacheTokens: sumOptional(
          acc.inputTokenDetails.noCacheTokens,
          u.inputTokenDetails.noCacheTokens
        ),
        cacheReadTokens: sumOptional(
          acc.inputTokenDetails.cacheReadTokens,
          u.inputTokenDetails.cacheReadTokens
        ),
        cacheWriteTokens: sumOptional(
          acc.inputTokenDetails.cacheWriteTokens,
          u.inputTokenDetails.cacheWriteTokens
        ),
      },
      outputTokens: sumOptional(acc.outputTokens, u.outputTokens),
      outputTokenDetails: {
        textTokens: sumOptional(acc.outputTokenDetails.textTokens, u.outputTokenDetails.textTokens),
        reasoningTokens: sumOptional(
          acc.outputTokenDetails.reasoningTokens,
          u.outputTokenDetails.reasoningTokens
        ),
      },
      totalTokens: sumOptional(acc.totalTokens, u.totalTokens),
    }),
    zero
  );
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
   * @returns Solved text, per-attempt answers, and token usage
   */
  async solve(input: string | Buffer, options: SolveOptions = {}): Promise<SolveResult> {
    const {
      numAttempts = 5,
      expectedLength,
      maxRetries = 2,
      verbose = true,
      confusionGroups = false,
      preprocess,
    } = options;

    const model = await this.getModel();
    const imageBuffer = await preprocessCaptchaToBuffer(input, preprocess);

    // Fire all attempts in parallel for speed
    const results = await Promise.all(
      Array.from({ length: numAttempts }, () => this.singleAttempt(model, imageBuffer, maxRetries))
    );
    const valid = results.filter((r): r is AttemptResult => r !== null);
    if (verbose) {
      valid.forEach((r, i) => console.log(`  Attempt ${i + 1}: ${r.text}`));
    }

    const attempts = valid.map((r) => r.text);
    const attemptUsages = valid.map((r) => r.usage);
    const usage = aggregateUsage(attemptUsages);

    if (attempts.length === 0) {
      if (verbose) console.log('  All attempts failed!');
      return { text: '', attempts, usage, attemptUsages };
    }

    return {
      text: majorityVote(attempts, expectedLength, confusionGroups),
      attempts,
      usage,
      attemptUsages,
    };
  }

  /**
   * Make a single API call to read the captcha.
   * Retries up to `maxRetries` times on failure.
   */
  private async singleAttempt(
    model: LanguageModel,
    imageBuffer: Buffer,
    maxRetries: number
  ): Promise<AttemptResult | null> {
    for (let retry = 0; retry <= maxRetries; retry++) {
      try {
        const { text, usage } = await generateText({
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
        return cleaned ? { text: cleaned, usage } : null;
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
