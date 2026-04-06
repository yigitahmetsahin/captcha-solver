import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { preprocessCaptcha } from './preprocess.js';

const TEST_CAPTCHA = path.resolve(__dirname, '..', 'test-captcha.png');
const hasFixture = fs.existsSync(TEST_CAPTCHA);

describe.skipIf(!hasFixture)('preprocessCaptcha', () => {
  it('returns a valid base64-encoded PNG', async () => {
    const b64 = await preprocessCaptcha(TEST_CAPTCHA);

    // Should be non-empty base64
    expect(b64.length).toBeGreaterThan(0);
    expect(() => Buffer.from(b64, 'base64')).not.toThrow();

    // Should decode as a valid image
    const buf = Buffer.from(b64, 'base64');
    const meta = await sharp(buf).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  });

  it('upscales and crops to expected dimensions', async () => {
    const b64 = await preprocessCaptcha(TEST_CAPTCHA);
    const buf = Buffer.from(b64, 'base64');
    const meta = await sharp(buf).metadata();

    // Original is 200x70 → 4x = 800x280
    // Crop: left=80, top=5, right=720, bottom=168 → 640x163
    // Padding: +60 width, +40 height → 700x203
    expect(meta.width).toBe(700);
    expect(meta.height).toBe(203);
  });

  it('produces a high-contrast image suitable for OCR', async () => {
    const b64 = await preprocessCaptcha(TEST_CAPTCHA);
    const buf = Buffer.from(b64, 'base64');

    const stats = await sharp(buf).greyscale().stats();
    const { min, max } = stats.channels[0];

    // After 3× contrast, the image should span a wide range
    expect(max - min).toBeGreaterThan(100);
  });
});
