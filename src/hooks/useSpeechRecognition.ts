import { useState, useRef, useCallback, useEffect } from 'react';
import { TRANSCRIPT_CLEAR_MS } from '@/lib/transcription';

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string; confidence?: number };
}
interface RecognitionClient {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => RecognitionClient;
const getRecognition = () => {
  const browser = window as typeof window & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return browser.SpeechRecognition || browser.webkitSpeechRecognition;
};

/** Show only the newest finalized microphone utterance, then clear it after quiet. */
export function useSpeechRecognition(language = navigator.language || 'en-US') {
  const [transcript, setTranscript] = useState('');
  const [transcriptRevision, setTranscriptRevision] = useState(0);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<RecognitionClient | null>(null);
  const desiredRef = useRef(false);
  const clearTimerRef = useRef<number | null>(null);
  const restartTimerRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = null;
    setTranscript('');
    setInterimTranscript('');
  }, []);

  const stop = useCallback(() => {
    desiredRef.current = false;
    if (restartTimerRef.current) window.clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onstart = null;
      try { recognition.abort(); } catch { /* Already ended. */ }
    }
    setIsListening(false);
    clear();
  }, [clear]);

  useEffect(() => {
    setSupported(Boolean(getRecognition()));
    return stop;
  }, [stop]);

  const start = useCallback(() => {
    if (desiredRef.current || recognitionRef.current) return;
    const SpeechRecognition = getRecognition();
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.lang = language;
    let finalizedThrough = -1;
    let retryDelay = 100;
    desiredRef.current = true;
    recognitionRef.current = recognition;
    setError(null);

    recognition.onstart = () => {
      if (recognitionRef.current !== recognition) return;
      finalizedThrough = -1;
      retryDelay = 100;
      setIsListening(true);
    };
    recognition.onresult = event => {
      if (!desiredRef.current || recognitionRef.current !== recognition) return;
      const finals: string[] = [];
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript?.trim();
        if (!text) continue;
        if (result.isFinal) {
          if (i > finalizedThrough) finals.push(text);
          finalizedThrough = Math.max(finalizedThrough, i);
        }
      }
      if (!finals.length) return;
      setTranscript(finals[finals.length - 1]);
      setTranscriptRevision(revision => revision + 1);
      setInterimTranscript('');
      if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = window.setTimeout(clear, TRANSCRIPT_CLEAR_MS);
    };
    recognition.onerror = event => {
      if (recognitionRef.current !== recognition) return;
      if (event.error !== 'no-speech' && event.error !== 'aborted') setError(event.error);
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(event.error)) {
        stop();
      } else if (event.error === 'network') {
        retryDelay = Math.min(2000, retryDelay * 2);
      }
    };
    recognition.onend = () => {
      if (!desiredRef.current || recognitionRef.current !== recognition) return;
      setIsListening(false);
      setInterimTranscript('');
      restartTimerRef.current = window.setTimeout(() => {
        restartTimerRef.current = null;
        if (!desiredRef.current || recognitionRef.current !== recognition) return;
        finalizedThrough = -1;
        try { recognition.start(); } catch {
          stop();
          setError('Speech recognition could not restart.');
        }
      }, retryDelay);
    };
    try {
      recognition.start();
      setIsListening(true);
    } catch (startError) {
      stop();
      setError(startError instanceof Error ? startError.message : 'Speech recognition could not start.');
    }
  }, [language, clear, stop]);

  return { transcript, transcriptRevision, interimTranscript, isListening, supported, error, start, stop, clear };
}
