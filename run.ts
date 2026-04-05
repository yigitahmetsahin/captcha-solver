import 'dotenv/config';
import path from 'path';
import { solveCaptchaImage } from './src/index.js';

async function main() {
  const args = process.argv.slice(2);
  const benchmarkIdx = args.indexOf('--benchmark');
  const isBenchmark = benchmarkIdx !== -1;
  const benchmarkCount = isBenchmark ? parseInt(args[benchmarkIdx + 1] || '20', 10) : 1;
  const modelIdx = args.indexOf('--model');
  const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
  const skipArgs = new Set<string>();
  if (benchmarkIdx !== -1) {
    skipArgs.add(args[benchmarkIdx]);
    skipArgs.add(args[benchmarkIdx + 1]);
  }
  if (modelIdx !== -1) {
    skipArgs.add(args[modelIdx]);
    skipArgs.add(args[modelIdx + 1]);
  }
  const imagePath =
    args.find((a, i) => !a.startsWith('--') && !skipArgs.has(a)) || '../ornek-captcha.png';

  const resolvedPath = path.resolve(imagePath);

  if (!isBenchmark) {
    // --- Single solve ---
    console.log(`Solving captcha from: ${resolvedPath}` + (model ? ` (model: ${model})` : ''));
    const answer = await solveCaptchaImage(resolvedPath, {
      numAttempts: 5,
      expectedLength: 4,
      model,
    });
    console.log(`\nCaptcha answer: ${answer}`);
    return;
  }

  // --- Benchmark mode ---
  const CORRECT = 'O1RW';
  const modelName = model || 'o3';
  console.log(`Running ${benchmarkCount} benchmark solves...`);
  console.log(`Image: ${resolvedPath}`);
  console.log(`Model: ${modelName}`);
  console.log(`Expected: ${CORRECT}\n`);

  const results: { answer: string; pass: boolean }[] = [];

  for (let run = 1; run <= benchmarkCount; run++) {
    console.log(`========== RUN ${run}/${benchmarkCount} ==========`);
    const answer = await solveCaptchaImage(resolvedPath, {
      numAttempts: 5,
      expectedLength: 4,
      verbose: true,
      model,
    });
    const pass = answer === CORRECT;
    results.push({ answer, pass });
    console.log(`  Final: ${answer}  |  ${pass ? 'PASS' : 'FAIL'}\n`);
  }

  // --- Summary ---
  const passes = results.filter((r) => r.pass).length;
  console.log('='.repeat(50));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(50));
  for (let i = 0; i < results.length; i++) {
    const { answer, pass } = results[i];
    console.log(
      `  Run ${String(i + 1).padStart(2)}: ${answer.padEnd(8)}  ${pass ? 'PASS' : 'FAIL'}`
    );
  }
  console.log(
    `\nSuccess rate: ${passes}/${benchmarkCount} (${Math.round((passes / benchmarkCount) * 100)}%)`
  );

  // Character-level accuracy
  console.log('\nCharacter-level accuracy:');
  for (let pos = 0; pos < CORRECT.length; pos++) {
    const correctCount = results.filter(
      (r) => r.answer.length > pos && r.answer[pos] === CORRECT[pos]
    ).length;
    console.log(
      `  Position ${pos + 1} ("${CORRECT[pos]}"): ${correctCount}/${benchmarkCount} (${Math.round((correctCount / benchmarkCount) * 100)}%)`
    );
  }
}

main().catch(console.error);
