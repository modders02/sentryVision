import { describe, expect, it } from 'vitest';
import { validateSafetySpeech } from '@/lib/safetyValidation';

describe('safety validation layer', () => {
  it('accepts tulong as a normal urgent help phrase', () => {
    const result = validateSafetySpeech('tulong');
    expect(result.status).toBe('validated');
    expect(result.match.phrase).toBe('tulong');
    expect(result.match.category).toBe('help');
  });

  it('holds a bare sunog trigger for confirmation', () => {
    const result = validateSafetySpeech('sunog');
    expect(result.status).toBe('pending');
    expect(result.ambiguous).toBe(true);
  });

  it('accepts bare sunog when visual fire is present', () => {
    const result = validateSafetySpeech('sunog', { fireDetected: true });
    expect(result.status).toBe('validated');
    expect(result.corroborated).toBe(true);
  });

  it('accepts bare sunog when the same trigger repeats', () => {
    const result = validateSafetySpeech('sunog', { repeated: true });
    expect(result.status).toBe('validated');
    expect(result.corroborated).toBe(true);
  });

  it('accepts a longer fire phrase without extra corroboration', () => {
    const result = validateSafetySpeech('may sunog');
    expect(result.status).toBe('validated');
    expect(result.match.phrase).toBe('may sunog');
  });

  it('does not turn ordinary text into a safety trigger', () => {
    const result = validateSafetySpeech('magandang gabi');
    expect(result.status).toBe('idle');
    expect(result.match.matched).toBe(false);
  });
});
