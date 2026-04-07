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
  /**
   * Fraction of image height to keep from the top, cropping the bottom (default: 1.0, no pre-crop).
   * Useful for removing dark bands at the bottom of dithered captchas.
   */
  preCropHeight?: number;
  /** Median filter size at original resolution before other processing (default: 0, off). Odd number. */
  median?: number;
  /** Gaussian blur radius (default: 1.5). Set to 0 to skip. */
  blur?: number;
  /** Convert to greyscale (default: true) */
  greyscale?: boolean;
  /** Upscale factor (default: 4) */
  scale?: number;
  /** Upscale interpolation kernel (default: 'lanczos3') */
  upscaleKernel?: 'lanczos3' | 'nearest' | 'cubic' | 'mitchell';
  /** Gaussian blur applied AFTER upscaling — use large values (10-20) for dither removal (default: 0, off) */
  postBlur?: number;
  /** Normalise (stretch histogram to full range) before contrast/threshold (default: false) */
  normalise?: boolean;
  /** Contrast multiplier around image mean (default: 3.0). Set to 1 to skip. */
  contrast?: number;
  /** Enable unsharp-mask sharpening (default: true) */
  sharpen?: boolean;
  /** Binary threshold (0-255). Applied after contrast. (default: false, off) */
  threshold?: number | false;
  /** Invert colors (negate) after processing (default: false) */
  negate?: boolean;
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
  /** Resize final image to this width in pixels, maintaining aspect ratio (default: none). Useful for downscaling after high-res processing. */
  targetWidth?: number;
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
    preCropHeight = 1.0,
    median = 0,
    blur = 1.5,
    greyscale = true,
    scale = 4,
    upscaleKernel = 'lanczos3',
    postBlur = 0,
    normalise = false,
    contrast = 3.0,
    sharpen = true,
    threshold = false,
    negate = false,
    crop = 'auto',
    padding = true,
  } = options ?? {};

  let source: string | Buffer = typeof input === 'string' ? path.resolve(input) : input;

  // Read original dimensions
  const metadata = await sharp(source).metadata();
  const origW = metadata.width!;
  let origH = metadata.height!;

  // Step 0: Pre-crop bottom portion (removes dark bands in dithered captchas)
  if (preCropHeight < 1.0 && preCropHeight > 0) {
    const keepH = Math.floor(origH * preCropHeight);
    source = await sharp(source)
      .extract({ left: 0, top: 0, width: origW, height: keepH })
      .toBuffer();
    origH = keepH;
  }

  // Step 1: Median filter at original resolution (great for salt-pepper / dither noise)
  let pipeline = sharp(source);
  if (median > 0) pipeline = pipeline.median(median);

  // Step 2: Blur (optional) at original resolution
  if (blur > 0) pipeline = pipeline.blur(blur);

  // Step 3: Greyscale (optional)
  if (greyscale) pipeline = pipeline.greyscale();
  const smoothed = await pipeline.toBuffer();

  // Step 4: Upscale with configurable kernel
  const upscaled = await sharp(smoothed)
    .resize(origW * scale, origH * scale, { kernel: upscaleKernel })
    .toBuffer();

  // Step 5: Post-upscale blur (for dither removal on the enlarged image)
  let postProcessed = upscaled;
  if (postBlur > 0) {
    postProcessed = await sharp(upscaled).blur(postBlur).toBuffer();
  }

  // Step 6: Normalise (optional — stretch histogram to full range)
  if (normalise) {
    postProcessed = await sharp(postProcessed).normalise().toBuffer();
  }

  // Step 7: Contrast boost + sharpen
  let enhanced: Buffer;
  if (contrast !== 1.0) {
    const stats = await sharp(postProcessed).stats();
    const mean = stats.channels[0].mean;
    let pipe = sharp(postProcessed).linear(contrast, mean * (1 - contrast));
    if (sharpen) pipe = pipe.sharpen({ sigma: 1.0, m1: 2.0, m2: 1.0 });
    enhanced = await pipe.toBuffer();
  } else {
    enhanced = sharpen
      ? await sharp(postProcessed).sharpen({ sigma: 1.0, m1: 2.0, m2: 1.0 }).toBuffer()
      : postProcessed;
  }

  // Step 8: Threshold (optional — binary B/W)
  if (threshold !== false && typeof threshold === 'number') {
    enhanced = await sharp(enhanced).threshold(threshold).toBuffer();
  }

  // Step 9: Target width resize (downscale after high-res processing)
  const targetWidth = options?.targetWidth;
  if (targetWidth && targetWidth > 0) {
    enhanced = await sharp(enhanced).resize(targetWidth, null, { kernel: 'lanczos3' }).toBuffer();
  }

  // Step 10: Crop
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
