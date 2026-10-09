import { matchWakeWord, type SafetyMatch } from '@/lib/safetyLexicon';

export type SafetyValidationStatus = 'idle' | 'pending' | 'validated';

export interface SafetyValidationContext {
  fireDetected?: boolean;
  smokeDetected?: boolean;
  repeated?: boolean;
}

export interface SafetyValidationResult {
  status: SafetyValidationStatus;
  match: SafetyMatch;
  ambiguous: boolean;
  corroborated: boolean;
  reason: string;
}

const AMBIGUOUS_SINGLE_WORD_FIRE = new Set(['fire', 'smoke', 'sunog']);

/**
 * Second-stage validation for speech safety triggers.
 *
 * Whole-word lexicon matching already prevents substring hits. This layer
 * handles a different failure mode: ASR can confuse short, acoustically
 * similar words. A single-word fire trigger therefore needs visual
 * corroboration or the same phrase repeated within the validation window.
 * Longer phrases and non-fire safety phrases keep their existing behavior.
 */
export function validateSafetySpeech(
  transcript: string,
  context: SafetyValidationContext = {},
): SafetyValidationResult {
  const match = matchWakeWord(transcript);
  if (!match.matched) {
    return {
      status: 'idle',
      match,
      ambiguous: false,
      corroborated: false,
      reason: 'No urgent safety phrase matched.',
    };
  }

  const words = match.phrase.trim().split(/\s+/).filter(Boolean);
  const ambiguous = match.category === 'fire'
    && words.length === 1
    && AMBIGUOUS_SINGLE_WORD_FIRE.has(match.phrase.toLocaleLowerCase());

  if (!ambiguous) {
    return {
      status: 'validated',
      match,
      ambiguous: false,
      corroborated: false,
      reason: 'Exact safety phrase matched the urgent lexicon.',
    };
  }

  if (context.fireDetected || context.smokeDetected) {
    return {
      status: 'validated',
      match,
      ambiguous: true,
      corroborated: true,
      reason: 'Short fire phrase confirmed by visual fire/smoke evidence.',
    };
  }

  if (context.repeated) {
    return {
      status: 'validated',
      match,
      ambiguous: true,
      corroborated: true,
      reason: 'Short fire phrase confirmed by a repeated speech match.',
    };
  }

  return {
    status: 'pending',
    match,
    ambiguous: true,
    corroborated: false,
    reason: 'Short fire phrase needs visual confirmation or one repeat before alerting.',
  };
}

export const SAFETY_VALIDATION_REPEAT_MS = 6000;
