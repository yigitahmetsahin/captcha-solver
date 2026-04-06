import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

/**
 * Preprocess a captcha image using sharp (libvips).
 *
 * Pipeline:
 *   1. Gaussian blur in color space (smooths dither pattern)
 *   2. Grayscale conversion
 *   3. Upscale 4× with Lanczos
 *   4. Contrast boost (3× around image mean) + sharpen
 *   5. Crop decorative borders
 *   6. Add white padding
 *
 * Accepts a file path or a raw image Buffer.
 * Returns a base64-encoded PNG string.
 */
export async function preprocessCaptcha(input: string | Buffer): Promise<string> {
  const buf = await preprocessCaptchaToBuffer(input);
  return buf.toString('base64');
}

/**
 * Same preprocessing pipeline as `preprocessCaptcha`, but returns the
 * resulting PNG as a raw Buffer (useful for AI SDK image content parts).
 */
export async function preprocessCaptchaToBuffer(input: string | Buffer): Promise<Buffer> {
  const source = typeof input === 'string' ? path.resolve(input) : input;

  // Read original dimensions for crop/resize calculations
  const metadata = await sharp(source).metadata();
  const origW = metadata.width!;
  const origH = metadata.height!;

  // Step 1-2: Blur in color space (smooths dither pattern) → greyscale
  // Separate from resize to prevent pipeline reordering
  const smoothed = await sharp(source).blur(1.5).greyscale().toBuffer();

  // Step 3: Upscale 4× with Lanczos
  const upscaled = await sharp(smoothed)
    .resize(origW * 4, origH * 4, { kernel: 'lanczos3' })
    .toBuffer();

  // Step 4: Contrast 3× around actual image mean + sharpen
  // Matches PIL's ImageEnhance.Contrast: output = factor*input + mean*(1-factor)
  const stats = await sharp(upscaled).stats();
  const mean = stats.channels[0].mean;
  const enhanced = await sharp(upscaled)
    .linear(3.0, mean * (1 - 3.0))
    .sharpen({ sigma: 1.0, m1: 2.0, m2: 1.0 })
    .toBuffer();

  // Step 5: Crop decorative borders
  // Remove 10% left/right, 2% top, 40% bottom (keep top 60%)
  // Math.floor matches Python's int() truncation
  const scaledW = origW * 4;
  const scaledH = origH * 4;
  const cropLeft = Math.floor(scaledW * 0.1);
  const cropTop = Math.floor(scaledH * 0.02);
  const cropRight = Math.floor(scaledW * 0.9);
  const cropBottom = Math.floor(scaledH * 0.6);
  const cropW = cropRight - cropLeft;
  const cropH = cropBottom - cropTop;

  // Step 5-6: Crop → add white padding → output PNG
  return sharp(enhanced)
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
    .extend({
      top: 20,
      bottom: 20,
      left: 30,
      right: 30,
      background: { r: 255, g: 255, b: 255 },
    })
    .png()
    .toBuffer();
}

/**
 * Read an image file and return its base64-encoded content.
 */
export function imageToBase64(imagePath: string): string {
  const buffer = fs.readFileSync(imagePath);
  return buffer.toString('base64');
}
