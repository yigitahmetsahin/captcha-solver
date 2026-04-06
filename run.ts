import 'dotenv/config';
import path from 'path';
import { Solver, LEGACY_CONFUSION_GROUPS } from './src/index.js';

async function main() {
  const args = process.argv.slice(2);
  const benchmarkIdx = args.indexOf('--benchmark');
  const isBenchmark = benchmarkIdx !== -1;
  const benchmarkCount = isBenchmark ? parseInt(args[benchmarkIdx + 1] || '20', 10) : 1;
  const modelIdx = args.indexOf('--model');
  const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
  const providerIdx = args.indexOf('--provider');
  const provider = providerIdx !== -1 ? args[providerIdx + 1] : undefined;
  const skipArgs = new Set<string>();
  if (benchmarkIdx !== -1) {
    skipArgs.add(args[benchmarkIdx]);
    skipArgs.add(args[benchmarkIdx + 1]);
  }
  if (modelIdx !== -1) {
    skipArgs.add(args[modelIdx]);
    skipArgs.add(args[modelIdx + 1]);
  }
  if (providerIdx !== -1) {
    skipArgs.add(args[providerIdx]);
    skipArgs.add(args[providerIdx + 1]);
  }
  const imagePath =
    args.find((a, i) => !a.startsWith('--') && !skipArgs.has(a)) || 'test-captcha.png';

  const resolvedPath = path.resolve(imagePath);

  // Determine API key based on provider
  const prov = (provider ?? 'openai') as 'openai' | 'anthropic' | 'google';
  const envKeys: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  };
  const apiKey = process.env[envKeys[prov] ?? 'OPENAI_API_KEY'];
  if (!apiKey) {
    console.error(`Missing ${envKeys[prov]} environment variable`);
    process.exit(1);
  }

  const solver = new Solver(apiKey, { provider: prov, model });

  if (!isBenchmark) {
    // --- Single solve ---
    const label = [model, provider].filter(Boolean).join(', ');
    console.log(`Solving captcha from: ${resolvedPath}` + (label ? ` (${label})` : ''));
    const result = await solver.solve(resolvedPath, {
      numAttempts: 5,
      expectedLength: 4,
      confusionGroups: LEGACY_CONFUSION_GROUPS,
    });
    console.log(`\nCaptcha answer: ${result.text}`);
    console.log(`Tokens used: ${result.usage.totalTokens ?? 'N/A'}`);
    return;
  }

  // --- Benchmark mode ---
  const CORRECT = 'O1RW';
  console.log(`Running ${benchmarkCount} benchmark solves...`);
  console.log(`Image: ${resolvedPath}`);
  console.log(`Provider: ${prov}${model ? `, Model: ${model}` : ''}`);
  console.log(`Expected: ${CORRECT}\n`);

  const results: { answer: string; pass: boolean }[] = [];

  for (let run = 1; run <= benchmarkCount; run++) {
    console.log(`========== RUN ${run}/${benchmarkCount} ==========`);
    const result = await solver.solve(resolvedPath, {
      numAttempts: 5,
      expectedLength: 4,
      verbose: true,
      confusionGroups: LEGACY_CONFUSION_GROUPS,
    });
    const pass = result.text === CORRECT;
    results.push({ answer: result.text, pass });
    console.log(`  Final: ${result.text}  |  ${pass ? 'PASS' : 'FAIL'}\n`);
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
