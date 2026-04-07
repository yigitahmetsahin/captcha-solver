import sharp from 'sharp';

// ── Types ────────────────────────────────────────────────────────────

interface CharRegion {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface CharFeatures {
  hasHoleBottom: boolean; // closed loop in bottom half → "6"
  hasHoleTop: boolean; // closed loop in top half → "0", "8"
  holeCount: number;
  aspectRatio: number; // height / width — "1" is very tall & narrow
  bottomHorizontalExtent: number; // fraction of width with dark pixels at bottom → "L" has wide bottom
  topHorizontalExtent: number; // fraction of width with dark pixels at top
  topCurvature: boolean; // curved top → "2", "6"; flat/absent → "1", "L", "Z"
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Disambiguate characters in a voted result using deterministic image features.
 * Only acts on positions voted as "2" or "Z" where alternatives like 6/L/1 received votes.
 *
 * @param result - The voted character array (mutable, modified in place)
 * @param rankedByPos - Per-position vote counts from majorityVote
 * @param binaryImage - The preprocessed binary image buffer (dark text on white, from threshold+negate)
 */
export async function disambiguateResult(
  result: string[],
  rankedByPos: Map<string, number>[],
  binaryImage: Buffer
): Promise<void> {
  // Only disambiguate positions voted as "2" or "Z" (the commonly confused characters)
  const ambiguousPositions: number[] = [];
  for (let pos = 0; pos < result.length; pos++) {
    if (result[pos] !== '2' && result[pos] !== 'Z') continue;
    const ranked = rankedByPos[pos];
    const hasAlt =
      (ranked.get('6') ?? 0) >= 1 || (ranked.get('L') ?? 0) >= 1 || (ranked.get('1') ?? 0) >= 1;
    if (hasAlt) {
      ambiguousPositions.push(pos);
      continue;
    }
    // Also trigger when 3+ positions are "2"/"Z" (suspiciously repetitive)
    const twoZCount = result.filter((c) => c === '2' || c === 'Z').length;
    if (twoZCount >= 3) {
      ambiguousPositions.push(pos);
    }
  }

  if (ambiguousPositions.length === 0) return;

  // Invert the image so characters are WHITE (>128) on BLACK (<128) background.
  // White blobs are better separated from the dark background for analysis.
  const meta = await sharp(binaryImage).metadata();
  const fullW = meta.width!;
  const fullH = meta.height!;
  const cropTop = Math.floor(fullH * 0.12);
  const cropH = Math.floor(fullH * 0.76);
  const { data, info } = await sharp(binaryImage)
    .extract({ left: 0, top: cropTop, width: fullW, height: cropH })
    .greyscale()
    .negate() // now: chars=WHITE(255), bg=BLACK(0)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const pixels = new Uint8Array(data);

  // Segment characters by column projection
  const regions = segmentCharacters(pixels, w, h, result.length);
  if (!regions || regions.length !== result.length) return; // segmentation failed

  // Analyse and disambiguate each ambiguous position
  for (const pos of ambiguousPositions) {
    const region = regions[pos];
    const features = analyseCharacter(pixels, w, h, region);
    const newChar = classifyFromFeatures(features, result[pos]);
    if (newChar) {
      result[pos] = newChar;
    }
  }
}

// ── Character segmentation ──────────────────────────────────────────

/**
 * Segment the image into N character regions using valley detection in column projection.
 * Computes dark-pixel density per column, smooths, then finds N-1 deepest valleys.
 */
function segmentCharacters(
  pixels: Uint8Array,
  w: number,
  h: number,
  expectedCount: number
): CharRegion[] | null {
  // Column projection: count dark pixels per column
  const colDensity = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < h; y++) {
      if (pixels[y * w + x] >= 128) count++;
    }
    colDensity[x] = count / h;
  }

  // Find content bounds (skip padding)
  let contentLeft = 0;
  let contentRight = w;
  for (let x = 0; x < w; x++) {
    if (colDensity[x] > 0.05) {
      contentLeft = x;
      break;
    }
  }
  for (let x = w - 1; x >= 0; x--) {
    if (colDensity[x] > 0.05) {
      contentRight = x + 1;
      break;
    }
  }

  // Smooth the density with a moving average (window=15)
  const smoothW = 15;
  const smoothed = new Float64Array(w);
  for (let x = contentLeft; x < contentRight; x++) {
    let sum = 0;
    let count = 0;
    for (let dx = -smoothW; dx <= smoothW; dx++) {
      const nx = x + dx;
      if (nx >= contentLeft && nx < contentRight) {
        sum += colDensity[nx];
        count++;
      }
    }
    smoothed[x] = sum / count;
  }

  // Find N-1 valleys (local minima) to divide into N regions
  // Enforce generous margins so splits aren't too close to edges
  const charWidth = (contentRight - contentLeft) / expectedCount;
  const margin = Math.floor(charWidth * 0.6); // at least 60% of avg char width from edge
  const searchLeft = contentLeft + margin;
  const searchRight = contentRight - margin;

  // Collect all local minima with their depth
  const valleys: { x: number; depth: number }[] = [];
  for (let x = searchLeft + 1; x < searchRight - 1; x++) {
    if (smoothed[x] <= smoothed[x - 1] && smoothed[x] <= smoothed[x + 1]) {
      // Local minimum — compute depth as difference from neighbors
      const leftMax = Math.max(...Array.from(smoothed.slice(Math.max(searchLeft, x - 40), x)));
      const rightMax = Math.max(
        ...Array.from(smoothed.slice(x + 1, Math.min(searchRight, x + 41)))
      );
      const depth = Math.min(leftMax, rightMax) - smoothed[x];
      if (depth > 0.01) {
        valleys.push({ x, depth });
      }
    }
  }

  // Sort by depth (deepest first) and pick N-1 non-overlapping valleys
  valleys.sort((a, b) => b.depth - a.depth);
  const splits: number[] = [];
  const minDist = charWidth * 0.6; // splits must be at least 60% of avg char width apart
  for (const v of valleys) {
    if (splits.length >= expectedCount - 1) break;
    if (splits.every((s) => Math.abs(s - v.x) > minDist)) {
      splits.push(v.x);
    }
  }

  if (splits.length < expectedCount - 1) {
    // Fallback: evenly divide
    const step = (contentRight - contentLeft) / expectedCount;
    splits.length = 0;
    for (let i = 1; i < expectedCount; i++) {
      splits.push(Math.floor(contentLeft + step * i));
    }
  }

  splits.sort((a, b) => a - b);
  const boundaries = [contentLeft, ...splits, contentRight];

  // Build regions with vertical bounds
  return boundaries.slice(0, expectedCount).map((start, idx) => {
    const end = boundaries[idx + 1];
    let top = h;
    let bottom = 0;
    for (let y = 0; y < h; y++) {
      for (let x = start; x < end; x++) {
        if (pixels[y * w + x] >= 128) {
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    return { left: start, right: end, top: Math.max(0, top), bottom: Math.min(h, bottom + 1) };
  });
}

// ── Hole detection ──────────────────────────────────────────────────

/**
 * Detect enclosed holes inside text characters using BFS flood-fill.
 * Image is WHITE-on-BLACK (text=white, bg=black).
 * Holes = BLACK regions enclosed by WHITE text, unreachable from the border.
 * Starts BFS from all border BLACK pixels; unvisited BLACK pixels = holes.
 */
function detectHoles(
  pixels: Uint8Array,
  imgW: number,
  region: CharRegion
): { count: number; hasBottom: boolean; hasTop: boolean } {
  const rw = region.right - region.left;
  const rh = region.bottom - region.top;
  if (rw < 3 || rh < 3) return { count: 0, hasBottom: false, hasTop: false };

  // Extract region: 1 = WHITE (text), 0 = BLACK (background/potential hole)
  const grid = new Uint8Array(rw * rh);
  for (let ly = 0; ly < rh; ly++) {
    for (let lx = 0; lx < rw; lx++) {
      const px = pixels[(region.top + ly) * imgW + (region.left + lx)];
      grid[ly * rw + lx] = px >= 128 ? 1 : 0;
    }
  }

  // BFS flood-fill from all border BLACK (0) pixels
  const visited = new Uint8Array(rw * rh);
  const queue: number[] = [];

  for (let lx = 0; lx < rw; lx++) {
    if (grid[lx] === 0 && !visited[lx]) {
      visited[lx] = 1;
      queue.push(lx);
    }
    const bottom = (rh - 1) * rw + lx;
    if (grid[bottom] === 0 && !visited[bottom]) {
      visited[bottom] = 1;
      queue.push(bottom);
    }
  }
  for (let ly = 0; ly < rh; ly++) {
    const left = ly * rw;
    if (grid[left] === 0 && !visited[left]) {
      visited[left] = 1;
      queue.push(left);
    }
    const right = ly * rw + rw - 1;
    if (grid[right] === 0 && !visited[right]) {
      visited[right] = 1;
      queue.push(right);
    }
  }

  // BFS
  let qi = 0;
  while (qi < queue.length) {
    const idx = queue[qi++];
    const lx = idx % rw;
    const ly = Math.floor(idx / rw);
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ] as const) {
      const nx = lx + dx;
      const ny = ly + dy;
      if (nx < 0 || nx >= rw || ny < 0 || ny >= rh) continue;
      const ni = ny * rw + nx;
      if (!visited[ni] && grid[ni] === 0) {
        visited[ni] = 1;
        queue.push(ni);
      }
    }
  }

  // Any BLACK (0) pixel not visited = enclosed hole inside white text
  let holeCount = 0;
  let hasBottom = false;
  let hasTop = false;
  const midY = rh / 2;

  // Use flood-fill to count distinct holes
  for (let ly = 0; ly < rh; ly++) {
    for (let lx = 0; lx < rw; lx++) {
      const idx = ly * rw + lx;
      if (grid[idx] === 0 && !visited[idx]) {
        // Found an unvisited black region enclosed by white — measure its area
        const holeQueue = [idx];
        visited[idx] = 1;
        let hi = 0;
        let area = 0;
        let sumY = 0;
        while (hi < holeQueue.length) {
          const hidx = holeQueue[hi++];
          area++;
          sumY += Math.floor(hidx / rw);
          const hx = hidx % rw;
          const hy = Math.floor(hidx / rw);
          for (const [dx, dy] of [
            [0, 1],
            [0, -1],
            [1, 0],
            [-1, 0],
          ] as const) {
            const hnx = hx + dx;
            const hny = hy + dy;
            if (hnx < 0 || hnx >= rw || hny < 0 || hny >= rh) continue;
            const hni = hny * rw + hnx;
            if (!visited[hni] && grid[hni] === 0) {
              visited[hni] = 1;
              holeQueue.push(hni);
            }
          }
        }

        // Only count holes larger than 0.5% of the character area (filters out tiny blur artifacts)
        const charArea = rw * rh;
        if (area > charArea * 0.005) {
          holeCount++;
          const avgY = sumY / area;
          if (avgY >= midY) hasBottom = true;
          else hasTop = true;
        }
      }
    }
  }

  return { count: holeCount, hasBottom, hasTop };
}

// ── Character analysis ──────────────────────────────────────────────

function analyseCharacter(
  pixels: Uint8Array,
  imgW: number,
  _imgH: number,
  region: CharRegion
): CharFeatures {
  const rw = region.right - region.left;
  const rh = region.bottom - region.top;
  const holes = detectHoles(pixels, imgW, region);

  // Aspect ratio (height / width)
  const aspectRatio = rh / Math.max(rw, 1);

  // Width of text in top 25% vs bottom 25%
  const quarterH = Math.max(3, Math.floor(rh * 0.25));
  let topMinX = rw,
    topMaxX = 0,
    botMinX = rw,
    botMaxX = 0;
  for (let lx = 0; lx < rw; lx++) {
    for (let ly = 0; ly < quarterH; ly++) {
      if (pixels[(region.top + ly) * imgW + (region.left + lx)] >= 128) {
        if (lx < topMinX) topMinX = lx;
        if (lx > topMaxX) topMaxX = lx;
      }
    }
    for (let ly = rh - quarterH; ly < rh; ly++) {
      if (pixels[(region.top + ly) * imgW + (region.left + lx)] >= 128) {
        if (lx < botMinX) botMinX = lx;
        if (lx > botMaxX) botMaxX = lx;
      }
    }
  }
  const topWidth = topMaxX > topMinX ? (topMaxX - topMinX) / rw : 0;
  const bottomWidth = botMaxX > botMinX ? (botMaxX - botMinX) / rw : 0;
  const bottomHorizontalExtent = bottomWidth;
  const topHorizontalExtent = topWidth;

  // Top curvature: is there significant dark area in the top-right quadrant?
  // "2" has a curved top-right; "1" and "L" don't
  const topQuarterH = Math.max(3, Math.floor(rh * 0.25));
  const rightHalf = Math.floor(rw / 2);
  let topRightDark = 0;
  let topRightTotal = 0;
  for (let ly = 0; ly < topQuarterH; ly++) {
    for (let lx = rightHalf; lx < rw; lx++) {
      topRightTotal++;
      if (pixels[(region.top + ly) * imgW + (region.left + lx)] >= 128) {
        topRightDark++;
      }
    }
  }
  const topCurvature = topRightTotal > 0 && topRightDark / topRightTotal > 0.15;

  return {
    hasHoleBottom: holes.hasBottom,
    hasHoleTop: holes.hasTop,
    holeCount: holes.count,
    aspectRatio,
    bottomHorizontalExtent,
    topHorizontalExtent,
    topCurvature,
  };
}

// ── Classification rules ────────────────────────────────────────────

function classifyFromFeatures(features: CharFeatures, _votedChar: string): string | null {
  // Rule 1: Closed loop at bottom → "6" (not "2")
  if (features.hasHoleBottom && !features.hasHoleTop) {
    return '6';
  }

  // Rule 2: Two holes → "8"
  if (features.holeCount >= 2) {
    return '8';
  }

  // Rule 3: One hole at top only → "0" or "9"
  if (features.hasHoleTop && !features.hasHoleBottom) {
    // Could be 0, 9, P, D — don't change unless we're sure
    return null;
  }

  // Rule 4: Very narrow (aspect ratio > 1.8) and no holes → "1"
  if (features.holeCount === 0 && features.aspectRatio > 1.8 && !features.topCurvature) {
    return '1';
  }

  // Rule 5: Bottom wider than top + no holes → "L"
  // L has a wide horizontal foot at bottom but narrow stem at top
  if (
    features.holeCount === 0 &&
    features.bottomHorizontalExtent > 0.5 &&
    features.bottomHorizontalExtent > features.topHorizontalExtent * 1.15 &&
    features.aspectRatio > 0.8
  ) {
    return 'L';
  }

  // No confident classification — keep the voted character
  return null;
}
