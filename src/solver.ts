import OpenAI from 'openai';
import { preprocessCaptcha } from './preprocess.js';

const PROMPT = `You are an assistant helping a visually impaired person read distorted text from an image.
The text contains uppercase letters A-Z and/or digits 0-9.
A thin vertical stroke is likely the digit 1, not the letter I.
A round closed shape is the letter O, not the letter D.
Output ONLY the exact characters you read, nothing else.`;

interface SolverOptions {
  /** OpenAI model to use (default: "o3") */
  model?: string;
  /** Number of voting attempts (default: 5) */
  numAttempts?: number;
  /** Expected captcha length — results of other lengths are discarded (default: undefined = no filter) */
  expectedLength?: number;
  /** Max retries per attempt on API failure (default: 2) */
  maxRetries?: number;
  /** Whether to log attempt details (default: true) */
  verbose?: boolean;
}

/**
 * Make a single API call to read the captcha.
 * Retries up to `maxRetries` times on failure.
 */
async function singleAttempt(
  client: OpenAI,
  base64Image: string,
  model: string,
  maxRetries: number
): Promise<string | null> {
  for (let retry = 0; retry <= maxRetries; retry++) {
    try {
      // Reasoning models (o3, o4-mini) use max_completion_tokens;
      // Standard models (gpt-4o, gpt-4.1, gpt-5.4-mini) use max_tokens.
      const isReasoningModel = model.startsWith('o');
      const tokenParam = isReasoningModel ? { max_completion_tokens: 2000 } : { max_tokens: 256 };

      const response = await client.chat.completions.create({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        temperature: 1,
        ...tokenParam,
      });

      const raw = response.choices[0]?.message?.content?.trim() ?? '';

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
        return null; // Model refused — don't count as an attempt
      }

      // Clean: keep only uppercase letters and digits
      const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
      return cleaned || null;
    } catch (_err) {
      if (retry < maxRetries) {
        // Wait briefly before retry
        await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Character-level majority vote across multiple attempts.
 */
function majorityVote(attempts: string[], expectedLength?: number): string {
  // Filter to expected length if specified
  let filtered = expectedLength ? attempts.filter((a) => a.length === expectedLength) : attempts;

  // If length filter removed everything, fall back to most common length
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

  // Vote per character position
  const result: string[] = [];
  for (let pos = 0; pos < bestLen; pos++) {
    const charCounts = new Map<string, number>();
    for (const a of sameLenAttempts) {
      const ch = a[pos];
      charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
    }
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

  return result.join('');
}

/**
 * Solve a captcha image using OpenAI vision + preprocessing + majority voting.
 */
export async function solveCaptchaImage(
  imagePath: string,
  options: SolverOptions = {}
): Promise<string> {
  const { model = 'o3', numAttempts = 5, expectedLength, maxRetries = 2, verbose = true } = options;

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Preprocess the image
  const base64Processed = await preprocessCaptcha(imagePath);

  // Run attempts — retry refusals/failures to guarantee numAttempts valid results
  const attempts: string[] = [];
  const maxTotalCalls = numAttempts + 4; // allow up to 4 extra calls for refusals
  let callCount = 0;
  while (attempts.length < numAttempts && callCount < maxTotalCalls) {
    callCount++;
    const result = await singleAttempt(client, base64Processed, model, maxRetries);
    if (result) {
      attempts.push(result);
      if (verbose) console.log(`  Attempt ${attempts.length}: ${result}`);
    } else {
      if (verbose) console.log(`  Call ${callCount}: (refused/failed, retrying...)`);
    }
  }

  if (attempts.length === 0) {
    if (verbose) console.log('  All attempts failed!');
    return '';
  }

  // Majority vote
  const answer = majorityVote(attempts, expectedLength);
  return answer;
}
