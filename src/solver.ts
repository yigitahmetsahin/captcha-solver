import type { LanguageModel, LanguageModelUsage } from 'ai';
import { generateText } from 'ai';
import type { PreprocessOptions } from './preprocess.js';
import { preprocessCaptchaToBuffer } from './preprocess.js';
import { disambiguateResult } from './disambiguate.js';
import type { TesseractReader } from './tesseract.js';

const PROMPT = `Read the 4 distorted characters in these images. Two processed versions shown.
The text uses UPPERCASE A-Z and digits 0-9 only. No lowercase.

WARNING: The dithered rendering makes many characters appear as "2". Before writing "2", check:
- Could it be "6"? (has closed loop at bottom)
- Could it be "L"? (has vertical stem + horizontal foot, 90° corner)
- Could it be "1"? (thin vertical stroke, no curve)
- Could it be "Z"? (all straight lines, sharp angles)

Also watch for: O/0 have curved sides (not D which has flat left); B has two bumps (not D with one curve); X is two crossing diagonals (not K with vertical bar); G has horizontal bar inside (not C).

Output ONLY the 4 characters.`;

// ── Types ────────────────────────────────────────────────────────────

export type Provider = 'openai' | 'anthropic' | 'google';

export interface SolverOptions {
  /** AI provider to use when constructing the model from an API key (default: "openai") */
  provider?: Provider;
  /** Model ID passed to the provider (default: "gpt-4o") */
  model?: string;
}

export interface SolveOptions {
  /** Number of voting attempts (default: 7) */
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
  /** Use Tesseract OCR as an additional voter (default: true if tesseract.js is installed) */
  useTesseract?: boolean;
  /** Use programmatic hole-detection to disambiguate 2/6/L/1 (default: true) */
  useDisambiguation?: boolean;
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

/**
 * Confusion groups optimised for dithered / halftone captchas.
 * Vision models systematically misread certain characters in dithered rendering.
 *
 * Maps: D→'O', I→'1', K/A→'X', C→'G', 9→'8', Y→'X', E→'5'
 */
export const DITHER_CONFUSION_GROUPS: Record<string, string> = {
  D: 'O',
  O: 'O',
  I: '1',
  '1': '1',
  K: 'X',
  X: 'X',
  A: 'X',
  C: 'G',
  G: 'G',
  '9': '8',
  '8': '8',
  Y: 'X',
  E: '5',
  '5': '5',
};

// ── Majority voting ──────────────────────────────────────────────────

/**
 * Character-level majority vote across multiple attempts.
 * When `groups` is provided, visually similar characters are merged
 * during counting (e.g. 1/I/L all count toward '1').
 *
 * After voting, a repetition penalty is applied: if any character appears
 * 3+ times in the result (unlikely in real captchas), positions with that
 * character are reconsidered using the next-best alternative.
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

  // Vote per character position, collecting full ranked results
  const result: string[] = [];
  const rankedByPos: Map<string, number>[] = [];

  for (let pos = 0; pos < bestLen; pos++) {
    const charCounts = new Map<string, number>();
    for (const a of sameLenAttempts) {
      const ch = a[pos];
      charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
    }

    if (useGroups) {
      const groupCounts = new Map<string, number>();
      for (const [ch, count] of charCounts) {
        const canonical = useGroups[ch] ?? ch;
        groupCounts.set(canonical, (groupCounts.get(canonical) ?? 0) + count);
      }
      rankedByPos.push(groupCounts);

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
      rankedByPos.push(charCounts);

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

  // Repetition penalty: captchas rarely have 3+ identical characters.
  // Keep the position with the strongest vote; substitute excess positions
  // with the best alternative that does NOT already appear in the result.
  if (bestLen >= 4) {
    const charFreq = new Map<string, number>();
    for (const ch of result) {
      charFreq.set(ch, (charFreq.get(ch) ?? 0) + 1);
    }
    for (const [ch, freq] of charFreq) {
      if (freq < 3) continue;
      // Find the position with the STRONGEST vote for this char — keep it
      let strongestPos = -1;
      let strongestCount = 0;
      for (let pos = 0; pos < bestLen; pos++) {
        if (result[pos] !== ch) continue;
        const count = rankedByPos[pos].get(ch) ?? 0;
        if (count > strongestCount) {
          strongestCount = count;
          strongestPos = pos;
        }
      }
      // Substitute excess positions, preferring chars NOT already in the result
      for (let pos = 0; pos < bestLen; pos++) {
        if (result[pos] !== ch || pos === strongestPos) continue;
        const ranked = rankedByPos[pos];
        const usedChars = new Set(result);
        // Prefer unique alternatives (not already in result)
        let bestUnique = '';
        let bestUniqueCount = 0;
        let bestAny = '';
        let bestAnyCount = 0;
        for (const [c, count] of ranked) {
          if (c === ch) continue;
          if (count > bestAnyCount) {
            bestAny = c;
            bestAnyCount = count;
          }
          if (!usedChars.has(c) && count > bestUniqueCount) {
            bestUnique = c;
            bestUniqueCount = count;
          }
        }
        // Prefer unique alternatives; fall back to any alternative
        const sub = bestUniqueCount >= 2 ? bestUnique : bestAnyCount >= 2 ? bestAny : '';
        if (sub) {
          result[pos] = sub;
        }
      }
    }
  }

  return result.join('');
}

/**
 * Raw character-level majority vote WITHOUT repetition penalty.
 * Returns per-position vote maps for disambiguation.
 */
export function majorityVoteDetailed(
  attempts: string[],
  expectedLength?: number,
  groups?: Record<string, string> | false
): { result: string[]; rankedByPos: Map<string, number>[] } {
  let filtered = expectedLength ? attempts.filter((a) => a.length === expectedLength) : attempts;
  if (filtered.length === 0) filtered = attempts;
  if (filtered.length === 0) return { result: [], rankedByPos: [] };

  const lenCounts = new Map<number, number>();
  for (const a of filtered) lenCounts.set(a.length, (lenCounts.get(a.length) ?? 0) + 1);
  let bestLen = 0;
  let bestCount = 0;
  for (const [len, count] of lenCounts) {
    if (count > bestCount) {
      bestLen = len;
      bestCount = count;
    }
  }
  const sameLenAttempts = filtered.filter((a) => a.length === bestLen);
  if (sameLenAttempts.length === 0) return { result: [...filtered[0]], rankedByPos: [] };

  const useGroups = groups && typeof groups === 'object' ? groups : undefined;
  const result: string[] = [];
  const rankedByPos: Map<string, number>[] = [];

  for (let pos = 0; pos < bestLen; pos++) {
    const counts = new Map<string, number>();
    for (const a of sameLenAttempts) {
      const ch = useGroups ? (useGroups[a[pos]] ?? a[pos]) : a[pos];
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    rankedByPos.push(counts);
    let bestChar = '';
    let bestCharCount = 0;
    for (const [ch, count] of counts) {
      if (count > bestCharCount) {
        bestChar = ch;
        bestCharCount = count;
      }
    }
    result.push(bestChar);
  }

  return { result, rankedByPos };
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
      numAttempts = 9,
      expectedLength,
      maxRetries = 2,
      verbose = true,
      confusionGroups = false,
      preprocess,
      useTesseract = true,
      useDisambiguation = true,
    } = options;

    const model = await this.getModel();

    // Three preprocessing variants with different blur levels for diversity:
    // 1. Enhanced grayscale (standard: high contrast + auto-crop)
    // 2. Heavy dither-clean (postBlur=15) — best for round/looped chars (G, 8, B, O)
    // 3. Medium dither-clean (postBlur=8)  — preserves thin strokes better (X, 1, L, 5)
    const [enhancedBuffer, heavyCleanBuffer, mediumCleanBuffer] = await Promise.all([
      preprocessCaptchaToBuffer(input, preprocess),
      preprocessCaptchaToBuffer(input, {
        blur: 0,
        greyscale: true,
        scale: 8,
        upscaleKernel: 'nearest',
        postBlur: 15,
        normalise: true,
        contrast: 1.0,
        sharpen: false,
        threshold: 140,
        negate: true,
        crop: 'none',
        targetWidth: 800,
        padding: 20,
      }),
      preprocessCaptchaToBuffer(input, {
        blur: 0,
        greyscale: true,
        scale: 8,
        upscaleKernel: 'nearest',
        postBlur: 8,
        normalise: true,
        contrast: 1.0,
        sharpen: false,
        threshold: 120,
        negate: true,
        crop: 'none',
        targetWidth: 800,
        padding: 20,
      }),
    ]);

    // Split vision model attempts across preprocessing variants for diverse reads
    const halfN = Math.ceil(numAttempts / 2);
    const visionResults = await Promise.all([
      ...Array.from({ length: halfN }, () =>
        this.singleAttempt(model, enhancedBuffer, heavyCleanBuffer, maxRetries)
      ),
      ...Array.from({ length: numAttempts - halfN }, () =>
        this.singleAttempt(model, enhancedBuffer, mediumCleanBuffer, maxRetries)
      ),
    ]);
    const valid = visionResults.filter((r): r is AttemptResult => r !== null);
    if (verbose) {
      valid.forEach((r, i) => console.log(`  Attempt ${i + 1}: ${r.text}`));
    }

    const attempts = valid.map((r) => r.text);
    const attemptUsages = valid.map((r) => r.usage);

    // Tesseract OCR as additional voter (algorithmic diversity)
    if (useTesseract) {
      try {
        const reader = await this.getTesseractReader();
        if (reader) {
          const { TESSERACT_VARIANTS } = await import('./tesseract.js');
          const tessReads = await reader.recognizeMulti(input, TESSERACT_VARIANTS);
          for (const read of tessReads) {
            attempts.push(read);
            if (verbose) console.log(`  Tesseract: ${read}`);
          }
        }
      } catch {
        // Tesseract not available — silently skip
      }
    }

    // Self-correction pass: re-ask the model to verify suspicious reads
    // This helps detect 6/L/1 that were misread as 2/Z in the initial pass
    const correctionAttempts = Math.min(3, Math.floor(numAttempts / 3));
    if (correctionAttempts > 0 && attempts.length > 0) {
      // Take the most common initial read as the basis for correction
      const initialVote = majorityVote(attempts, expectedLength, confusionGroups);
      const suspiciousCount = [...initialVote].filter((c) => c === '2' || c === 'Z').length;
      if (suspiciousCount >= 2 && initialVote.length === (expectedLength ?? initialVote.length)) {
        const corrPrompt = this.buildCorrectionPrompt(initialVote);
        if (corrPrompt) {
          const corrections = await Promise.all(
            Array.from({ length: correctionAttempts }, () =>
              this.selfCorrect(model, enhancedBuffer, heavyCleanBuffer, initialVote, corrPrompt)
            )
          );
          for (const c of corrections) {
            if (c) {
              // Weight corrections heavily — each correction counts as 5 votes
              for (let w = 0; w < 5; w++) attempts.push(c.text);
              if (verbose) console.log(`  Corrected: ${c.text}`);
            }
          }
        }
      }
    }

    const usage = aggregateUsage(attemptUsages);

    if (attempts.length === 0) {
      if (verbose) console.log('  All attempts failed!');
      return { text: '', attempts, usage, attemptUsages };
    }

    // Step 1: Raw vote (no repetition penalty yet)
    const { result, rankedByPos } = majorityVoteDetailed(attempts, expectedLength, confusionGroups);

    // Step 2: Programmatic disambiguation on raw vote
    // Two passes: heavy-clean for hole detection (→"6"), light-clean for shape features (→"L")
    if (useDisambiguation && result.length > 0 && rankedByPos.length > 0) {
      try {
        // Pass 1: hole detection on heavy-clean image (detects closed loops → "6", "8")
        await disambiguateResult(result, rankedByPos, heavyCleanBuffer);
        // Pass 2: shape features on light-clean image (detects L from width ratios)
        const lightCleanBuffer = await preprocessCaptchaToBuffer(input, {
          median: 3,
          blur: 0,
          greyscale: true,
          scale: 4,
          postBlur: 3,
          normalise: true,
          contrast: 1.0,
          sharpen: false,
          threshold: 128,
          crop: 'none',
          padding: 20,
        });
        await disambiguateResult(result, rankedByPos, lightCleanBuffer);
      } catch {
        // disambiguation failed — keep raw vote
      }
    }

    // Step 3: Apply repetition penalty + final vote (handles remaining issues)
    const finalText = majorityVote(
      [...attempts, result.join('')], // include disambiguated result as an extra "vote"
      expectedLength,
      confusionGroups
    );

    return {
      text: finalText,
      attempts,
      usage,
      attemptUsages,
    };
  }

  private _tesseractReader: TesseractReader | null | undefined = undefined;

  private async getTesseractReader(): Promise<TesseractReader | null> {
    if (this._tesseractReader !== undefined) return this._tesseractReader;
    try {
      const { createTesseractReader } = await import('./tesseract.js');
      this._tesseractReader = await createTesseractReader();
    } catch {
      this._tesseractReader = null;
    }
    return this._tesseractReader;
  }

  /** Clean up resources (Tesseract worker). */
  async dispose(): Promise<void> {
    if (this._tesseractReader) {
      await this._tesseractReader.dispose();
      this._tesseractReader = null;
    }
  }

  private buildCorrectionPrompt(initial: string): string | null {
    const checks = [...initial]
      .map((c, pos) => {
        if (c !== '2' && c !== 'Z') return null;
        if (pos === 0)
          return `Pos ${pos + 1} ("${c}"): thin stroke → "1"? closed loop at bottom → "6"? vertical+foot → "L"?`;
        if (pos < initial.length - 1)
          return `Pos ${pos + 1} ("${c}"): vertical + horizontal foot → "L"? thin stroke → "1"? loop → "6"?`;
        return `Pos ${pos + 1} ("${c}"): curved top → keep "2"; straight angles → "Z"`;
      })
      .filter(Boolean);
    if (!checks.length) return null;
    const prefix =
      [...initial].filter((c) => c === '2' || c === 'Z').length >= 3
        ? `"${initial}" has many similar chars — unusual for a captcha.\n`
        : '';
    return `${prefix}Recheck:\n${checks.join('\n')}\nOnly change with clear evidence. Output ONLY the corrected 4 characters.`;
  }

  private async selfCorrect(
    model: LanguageModel,
    primaryBuffer: Buffer,
    secondaryBuffer: Buffer,
    initial: string,
    correctionPrompt: string
  ): Promise<{ text: string } | null> {
    try {
      const { text } = await generateText({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image', image: primaryBuffer },
              { type: 'image', image: secondaryBuffer },
            ],
          },
          { role: 'assistant', content: initial },
          {
            role: 'user',
            content: [
              { type: 'text', text: correctionPrompt },
              { type: 'image', image: primaryBuffer },
            ],
          },
        ],
        temperature: 0.3,
        maxOutputTokens: 32,
      });
      const cleaned = text
        .trim()
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase();
      return cleaned.length >= 2 && cleaned.length <= 8 ? { text: cleaned } : null;
    } catch {
      return null;
    }
  }

  /**
   * Make a single API call to read the captcha.
   * Retries up to `maxRetries` times on failure.
   */
  private async singleAttempt(
    model: LanguageModel,
    primaryBuffer: Buffer,
    secondaryBuffer: Buffer,
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
                { type: 'image', image: primaryBuffer },
                { type: 'image', image: secondaryBuffer },
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
          lower.includes("i can't")
        ) {
          return null;
        }

        // Extract answer: if short, use directly; if long (reasoning model), find last 2-8 char alphanumeric token
        let answer = '';
        const allAlpha = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (allAlpha.length <= 10) {
          answer = allAlpha;
        } else {
          // Long output — scan lines from end for a short alphanumeric-only token
          const lines = raw.split(/\n/).reverse();
          for (const line of lines) {
            const tokens = line.trim().split(/\s+/);
            for (let ti = tokens.length - 1; ti >= 0; ti--) {
              const clean = tokens[ti].replace(/[^A-Za-z0-9]/g, '').toUpperCase();
              if (clean.length >= 2 && clean.length <= 8) {
                answer = clean;
                break;
              }
            }
            if (answer) break;
          }
          if (!answer) answer = allAlpha.slice(-8); // fallback: last 8 chars
        }
        return answer ? { text: answer, usage } : null;
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
