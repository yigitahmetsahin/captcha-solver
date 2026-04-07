export { Solver } from './solver.js';
export {
  majorityVote,
  majorityVoteDetailed,
  LEGACY_CONFUSION_GROUPS,
  DITHER_CONFUSION_GROUPS,
} from './solver.js';
export type { SolverOptions, SolveOptions, SolveResult, Provider } from './solver.js';
export type { LanguageModelUsage } from 'ai';
export { preprocessCaptcha, preprocessCaptchaToBuffer, imageToBase64 } from './preprocess.js';
export type { PreprocessOptions, CropFractions } from './preprocess.js';
export { createTesseractReader, TESSERACT_VARIANTS } from './tesseract.js';
export type { TesseractReader } from './tesseract.js';
export { disambiguateResult } from './disambiguate.js';
