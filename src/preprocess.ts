import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

// Inline Python script for image preprocessing
// Uses PIL which produces optimal results for captcha OCR
const PYTHON_SCRIPT = `
import sys, base64, io
from PIL import Image, ImageFilter, ImageEnhance, ImageOps

image_path = sys.argv[1]
img = Image.open(image_path)
img = ImageOps.grayscale(img)
img = img.filter(ImageFilter.GaussianBlur(radius=1.2))
img = img.resize((img.width * 4, img.height * 4), Image.LANCZOS)
img = ImageEnhance.Contrast(img).enhance(3.0)
img = ImageEnhance.Sharpness(img).enhance(2.0)
w, h = img.size
img = img.crop((int(w * 0.10), int(h * 0.02), int(w * 0.90), int(h * 0.60)))
padded = Image.new('L', (img.width + 60, img.height + 40), 255)
padded.paste(img, (30, 20))
padded = padded.convert('RGB')
buf = io.BytesIO()
padded.save(buf, format='PNG')
sys.stdout.buffer.write(base64.b64encode(buf.getvalue()))
`;

/**
 * Preprocess a captcha image using PIL (via Python subprocess).
 *
 * Pipeline:
 *   1. Grayscale
 *   2. Gaussian blur (radius=1.2) to smooth dither pattern
 *   3. Upscale 4x with Lanczos
 *   4. Contrast 3x + Sharpness 2x (PIL enhancement — preserves soft gradients)
 *   5. Crop decorative borders
 *   6. Add white padding
 *
 * Returns a base64-encoded PNG string.
 */
export async function preprocessCaptcha(imagePath: string): Promise<string> {
  const absPath = path.resolve(imagePath);

  // Write the Python script to a temp file
  const scriptPath = '/tmp/_captcha_preprocess.py';
  fs.writeFileSync(scriptPath, PYTHON_SCRIPT);

  // Execute Python and capture base64 output
  const result = execSync(`python3 "${scriptPath}" "${absPath}"`, {
    maxBuffer: 10 * 1024 * 1024, // 10MB
    encoding: 'utf-8',
  });

  return result.trim();
}

/**
 * Read an image file and return its base64-encoded content.
 */
export function imageToBase64(imagePath: string): string {
  const buffer = fs.readFileSync(imagePath);
  return buffer.toString('base64');
}
