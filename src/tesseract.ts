import type { PreprocessOptions } from './preprocess.js';
import { preprocessCaptchaToBuffer } from './preprocess.js';

// ── Types ────────────────────────────────────────────────────────────

interface TesseractWorker {
  setParameters: (params: Record<string, string>) => Promise<void>;
  recognize: (image: Buffer) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<void>;
}

export interface TesseractReader {
  recognize: (image: Buffer) => Promise<string>;
  recognizeMulti: (input: string | Buffer, variants: PreprocessOptions[]) => Promise<string[]>;
  dispose: () => Promise<void>;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Create a Tesseract OCR reader. Returns null if tesseract.js is not installed.
 * The reader uses PSM_SINGLE_LINE and an A-Z0-9 whitelist.
 */
export async function createTesseractReader(): Promise<TesseractReader | null> {
  let createWorker: (lang: string) => Promise<TesseractWorker>;
  try {
    const tess = await import('tesseract.js');
    createWorker = tess.createWorker as unknown as typeof createWorker;
  } catch {
    return null; // tesseract.js not installed
  }

  const worker = await createWorker('eng');
  await worker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    tessedit_pageseg_mode: '7', // PSM.SINGLE_LINE
  });

  return {
    async recognize(image: Buffer): Promise<string> {
      const { data } = await worker.recognize(image);
      return data.text.trim().replace(/[^A-Z0-9]/g, '');
    },

    async recognizeMulti(input: string | Buffer, variants: PreprocessOptions[]): Promise<string[]> {
      const results: string[] = [];
      for (const opts of variants) {
        try {
          const buf = await preprocessCaptchaToBuffer(input, opts);
          const { data } = await worker.recognize(buf);
          const clean = data.text.trim().replace(/[^A-Z0-9]/g, '');
          if (clean.length >= 2 && clean.length <= 8) {
            results.push(clean);
          }
        } catch {
          // skip failed variant
        }
      }
      return results;
    },

    async dispose(): Promise<void> {
      await worker.terminate();
    },
  };
}

/**
 * Default preprocessing variants for Tesseract OCR.
 * Different blur/threshold levels produce diverse reads.
 */
export const TESSERACT_VARIANTS: PreprocessOptions[] = [
  // Variant 1: standard enhanced
  {
    blur: 1.5,
    greyscale: true,
    scale: 4,
    contrast: 3.0,
    sharpen: true,
    crop: 'auto',
    padding: true,
  },
  // Variant 2: enhanced + negated
  {
    blur: 1.5,
    greyscale: true,
    scale: 4,
    contrast: 3.0,
    sharpen: true,
    negate: true,
    crop: 'auto',
    padding: true,
  },
];
