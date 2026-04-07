import dotenv from 'dotenv';
dotenv.config({ override: true });
// Fix: unset ANTHROPIC_BASE_URL if set without /v1 path (breaks SDK)
if (process.env.ANTHROPIC_BASE_URL && !process.env.ANTHROPIC_BASE_URL.includes('/v1')) {
  delete process.env.ANTHROPIC_BASE_URL;
}
import path from 'path';
import { Solver, majorityVote, DITHER_CONFUSION_GROUPS } from './src/index.js';

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
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const useEnsemble = !provider && !model && !!anthropicKey;

    if (useEnsemble) {
      // Multi-model ensemble: initial reads from all models, then coordinated self-correction
      console.log(`Solving captcha from: ${resolvedPath} (ensemble: gpt-4o + gpt-4.1 + claude)`);
      const s4o = new Solver(apiKey, { model: 'gpt-4o' });
      const s41 = new Solver(apiKey, { model: 'gpt-4.1' });
      const sCl = new Solver(anthropicKey, {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
      });

      // Stage 1: Get initial reads from all models (no self-correction)
      const opts = {
        numAttempts: 7,
        expectedLength: 4,
        verbose: false,
        useTesseract: false,
        useDisambiguation: false,
        confusionGroups: false as const,
      };
      const [r4o, r41, rCl] = await Promise.all([
        s4o.solve(resolvedPath, opts),
        s41.solve(resolvedPath, { ...opts, numAttempts: 5 }),
        sCl.solve(resolvedPath, opts),
      ]);
      const allInitial = [...r4o.attempts, ...r41.attempts, ...rCl.attempts];

      // Stage 2: Coordinated self-correction using aggregate initial vote
      const initialVote = majorityVote(allInitial, 4, DITHER_CONFUSION_GROUPS);
      const suspiciousCount = [...initialVote].filter((c) => c === '2' || c === 'Z').length;
      const { preprocessCaptchaToBuffer } = await import('./src/preprocess.js');
      const cleaned = await preprocessCaptchaToBuffer(resolvedPath, {
        blur: 0,
        greyscale: true,
        scale: 8,
        upscaleKernel: 'nearest',
        postBlur: 15,
        normalise: true,
        contrast: 1.0,
        sharpen: false,
        threshold: 140,
        negate: true,
        crop: 'none',
        targetWidth: 800,
        padding: 20,
      });

      const corrected: string[] = [];
      if (suspiciousCount >= 2 && initialVote.length === 4) {
        // Heuristic: if later positions are NOT 2/Z, then position 0 is likely "1" (thin stroke)
        // If ALL positions are 2/Z, then position 0 is more likely "6" (loop)
        const laterNon2Z = [...initialVote].slice(2).some((c) => c !== '2' && c !== 'Z');
        const checks = [...initialVote]
          .map((c, pos) => {
            if (c !== '2' && c !== 'Z') return null;
            if (pos === 0) {
              if (laterNon2Z)
                return `Pos ${pos + 1}("${c}"): is it a THIN single stroke → "1"? vertical+foot → "L"?`;
              return `Pos ${pos + 1}("${c}"): has closed LOOP at bottom → "6"? thin stroke → "1"? vertical+foot → "L"?`;
            }
            if (pos < 3)
              return `Pos ${pos + 1}("${c}"): vertical bar + horizontal FOOT → "L"? thin stroke → "1"?`;
            return `Pos ${pos + 1}("${c}"): curved top → keep "2"; straight angles → "Z"`;
          })
          .filter(Boolean);
        const prefix =
          suspiciousCount >= 3 ? `"${initialVote}" has many similar chars — unusual.\n` : '';
        const corrPrompt = `${prefix}Recheck:\n${checks.join('\n')}\nOnly change with clear evidence. Output ONLY the corrected 4 characters.`;

        // Run correction on all models
        const corrSolvers = [s4o, s4o, s4o, sCl, sCl, sCl, sCl, sCl];
        const enhanced = await preprocessCaptchaToBuffer(resolvedPath);
        const { generateText } = await import('ai');
        const { createOpenAI } = await import('@ai-sdk/openai');
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        const oaiModel = createOpenAI({ apiKey })(model || 'gpt-4o');
        const clModel = createAnthropic({ apiKey: anthropicKey })('claude-sonnet-4-20250514');
        const corrModels = [
          oaiModel,
          oaiModel,
          oaiModel,
          oaiModel,
          oaiModel,
          clModel,
          clModel,
          clModel,
          clModel,
          clModel,
          clModel,
          clModel,
          clModel,
          clModel,
          clModel,
        ];

        await Promise.all(
          corrModels.map(async (m) => {
            try {
              const { text } = await generateText({
                model: m,
                messages: [
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: 'Read the 4 distorted dithered characters. UPPERCASE A-Z and digits 0-9. Output ONLY the 4 characters.',
                      },
                      { type: 'image', image: enhanced },
                      { type: 'image', image: cleaned },
                    ],
                  },
                  { role: 'assistant', content: initialVote },
                  {
                    role: 'user',
                    content: [
                      { type: 'text', text: corrPrompt },
                      { type: 'image', image: enhanced },
                    ],
                  },
                ],
                temperature: 0.3,
                maxOutputTokens: 32,
              });
              const clean = text
                .trim()
                .replace(/[^A-Za-z0-9]/g, '')
                .toUpperCase();
              if (clean.length === 4) corrected.push(clean);
            } catch {}
          })
        );
        corrected.forEach((c) => console.log(`  Corrected: ${c}`));
      }

      // Stage 3: Combine initial + corrections and vote
      const all = [...allInitial, ...corrected];

      // Stage 4: Disambiguate the vote result using image features
      const { majorityVoteDetailed } = await import('./src/index.js');
      const { disambiguateResult } = await import('./src/disambiguate.js');
      const { result: voteResult, rankedByPos } = majorityVoteDetailed(
        all,
        4,
        DITHER_CONFUSION_GROUPS
      );
      if (voteResult.length === 4 && rankedByPos.length === 4) {
        try {
          await disambiguateResult(voteResult, rankedByPos, cleaned);
          const lightClean = await preprocessCaptchaToBuffer(resolvedPath, {
            median: 3,
            blur: 0,
            greyscale: true,
            scale: 4,
            postBlur: 3,
            normalise: true,
            contrast: 1.0,
            sharpen: false,
            threshold: 128,
            crop: 'none',
            padding: 20,
          });
          await disambiguateResult(voteResult, rankedByPos, lightClean);
        } catch {}
      }

      // Final vote including disambiguation result
      const answer = majorityVote([...all, voteResult.join('')], 4, DITHER_CONFUSION_GROUPS);
      console.log(`\nCaptcha answer: ${answer}`);
    } else {
      const label = [model, provider].filter(Boolean).join(', ');
      console.log(`Solving captcha from: ${resolvedPath}` + (label ? ` (${label})` : ''));
      const result = await solver.solve(resolvedPath, {
        numAttempts: 15,
        expectedLength: 4,
        confusionGroups: DITHER_CONFUSION_GROUPS,
        useTesseract: false,
      });
      console.log(`\nCaptcha answer: ${result.text}`);
      console.log(`Tokens used: ${result.usage.totalTokens ?? 'N/A'}`);
    }
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
