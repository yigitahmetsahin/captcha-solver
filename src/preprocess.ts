import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// ── Types ────────────────────────────────────────────────────────────

export interface CropFractions {
  /** Fraction from left edge (0–1, default: 0.1) */
  left: number;
  /** Fraction from top edge (0–1, default: 0.02) */
  top: number;
  /** Fraction from left to keep (0–1, default: 0.9) */
  right: number;
  /** Fraction from top to keep (0–1, default: 0.6) */
  bottom: number;
}

export interface PreprocessOptions {
  /** Gaussian blur radius (default: 1.5). Set to 0 to skip. */
  blur?: number;
  /** Upscale factor (default: 4) */
  scale?: number;
  /** Contrast multiplier around image mean (default: 3.0). Set to 1 to skip. */
  contrast?: number;
  /** Enable unsharp-mask sharpening (default: true) */
  sharpen?: boolean;
  /**
   * Crop mode (default: 'auto'):
   *  - 'auto'   – trim whitespace after contrast enhancement, with margin
   *  - 'legacy' – fixed-percentage crop (original behavior)
   *  - 'none'   – skip cropping
   *  - CropFractions – custom crop percentages
   */
  crop?: 'auto' | 'legacy' | 'none' | CropFractions;
  /** Add white padding around the result (default: true). Pass false to skip, or a number for custom px. */
  padding?: boolean | number;
  /** Invert colors (negate) after processing (default: false) */
  negate?: boolean;
  /** Convert to greyscale (default: true) */
  greyscale?: boolean;
}

const LEGACY_CROP: CropFractions = { left: 0.1, top: 0.02, right: 0.9, bottom: 0.6 };

// ── Public API ───────────────────────────────────────────────────────

/**
 * Preprocess a captcha image and return a base64-encoded PNG string.
 */
export async function preprocessCaptcha(
  input: string | Buffer,
  options?: PreprocessOptions
): Promise<string> {
  const buf = await preprocessCaptchaToBuffer(input, options);
  return buf.toString('base64');
}

/**
 * Preprocess a captcha image and return the resulting PNG as a raw Buffer.
 *
 * Pipeline:
 *   1. Gaussian blur in color space (smooths dither pattern)
 *   2. Grayscale conversion
 *   3. Upscale with Lanczos
 *   4. Contrast boost around image mean + sharpen
 *   5. Crop (auto-detect, legacy fixed, none, or custom)
 *   6. Add white padding
 */
export async function preprocessCaptchaToBuffer(
  input: string | Buffer,
  options?: PreprocessOptions
): Promise<Buffer> {
  const {
    blur = 1.5,
    scale = 4,
    contrast = 3.0,
    sharpen = true,
    crop = 'auto',
    padding = true,
    negate = false,
    greyscale = true,
  } = options ?? {};

  const source = typeof input === 'string' ? path.resolve(input) : input;

  // Read original dimensions
  const metadata = await sharp(source).metadata();
  const origW = metadata.width!;
  const origH = metadata.height!;

  // Step 1-2: Blur (optional) + greyscale (optional)
  let pipeline = sharp(source);
  if (blur > 0) pipeline = pipeline.blur(blur);
  if (greyscale) pipeline = pipeline.greyscale();
  const smoothed = await pipeline.toBuffer();

  // Step 3: Upscale with Lanczos
  const upscaled = await sharp(smoothed)
    .resize(origW * scale, origH * scale, { kernel: 'lanczos3' })
    .toBuffer();

  // Step 4: Contrast boost + sharpen
  let enhanced: Buffer;
  if (contrast !== 1.0) {
    const stats = await sharp(upscaled).stats();
    const mean = stats.channels[0].mean;
    let pipe = sharp(upscaled).linear(contrast, mean * (1 - contrast));
    if (sharpen) pipe = pipe.sharpen({ sigma: 1.0, m1: 2.0, m2: 1.0 });
    enhanced = await pipe.toBuffer();
  } else {
    enhanced = sharpen
      ? await sharp(upscaled).sharpen({ sigma: 1.0, m1: 2.0, m2: 1.0 }).toBuffer()
      : upscaled;
  }

  // Step 5: Crop
  let cropped: Buffer;
  if (crop === 'none') {
    cropped = enhanced;
  } else if (crop === 'auto') {
    cropped = await autoCrop(enhanced);
  } else {
    const fractions = crop === 'legacy' ? LEGACY_CROP : crop;
    const scaledW = origW * scale;
    const scaledH = origH * scale;
    const cropLeft = Math.floor(scaledW * fractions.left);
    const cropTop = Math.floor(scaledH * fractions.top);
    const cropRight = Math.floor(scaledW * fractions.right);
    const cropBottom = Math.floor(scaledH * fractions.bottom);
    const cropW = cropRight - cropLeft;
    const cropH = cropBottom - cropTop;
    cropped = await sharp(enhanced)
      .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
      .toBuffer();
  }

  // Step 6: Negate (optional)
  const final = negate ? await sharp(cropped).negate().toBuffer() : cropped;

  // Step 7: Padding
  if (padding === false) {
    return sharp(final).png().toBuffer();
  }
  const pad = typeof padding === 'number' ? padding : undefined;
  const vPad = pad ?? 20;
  const hPad = pad ?? 30;
  return sharp(final)
    .extend({
      top: vPad,
      bottom: vPad,
      left: hPad,
      right: hPad,
      background: { r: 255, g: 255, b: 255 },
    })
    .png()
    .toBuffer();
}

/**
 * Auto-crop: use sharp.trim() to detect the content bounding box after
 * contrast enhancement, then add a small margin. Falls back to the
 * untrimmed image if trim removes everything.
 */
async function autoCrop(enhanced: Buffer): Promise<Buffer> {
  try {
    const trimmed = sharp(enhanced).trim({ threshold: 30 });
    const trimmedBuf = await trimmed.toBuffer({ resolveWithObject: true });

    // If trim left a reasonable image, add a margin
    const { width, height } = trimmedBuf.info;
    if (width > 2 && height > 2) {
      return trimmedBuf.data;
    }
  } catch {
    // trim() can throw if image is uniform — fall through
  }

  // Fallback: return untrimmed
  return enhanced;
}

/**
 * Read an image file and return its base64-encoded content.
 */
export function imageToBase64(imagePath: string): string {
  const buffer = fs.readFileSync(imagePath);
  return buffer.toString('base64');
}
