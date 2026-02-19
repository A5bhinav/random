import { describe, it, expect, vi } from 'vitest';
import { TextChunker } from '../src/adapters/tts/chunker.js';

function collectSentences(chunker: TextChunker): string[] {
  const sentences: string[] = [];
  chunker.on('sentence', (s: string) => sentences.push(s));
  return sentences;
}

describe('TextChunker', () => {
  describe('addToken', () => {
    it('emits nothing until a sentence boundary is detected', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      chunker.addToken('Hello');
      chunker.addToken(' world');
      expect(sentences).toHaveLength(0);
    });

    it('emits a sentence when a period + whitespace is detected', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      chunker.addToken('Hello world. ');
      expect(sentences).toEqual(['Hello world.']);
    });

    it('emits on exclamation mark', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      chunker.addToken('Great! ');
      expect(sentences).toEqual(['Great!']);
    });

    it('emits on question mark', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      chunker.addToken('Really? ');
      expect(sentences).toEqual(['Really?']);
    });

    it('emits multiple sentences from a single token batch', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      chunker.addToken('First sentence. Second sentence. Third');
      expect(sentences).toEqual(['First sentence.', 'Second sentence.']);
    });

    it('splits correctly when boundary arrives across multiple tokens', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      chunker.addToken('Hello world');
      chunker.addToken('. ');
      chunker.addToken('Next sentence');
      expect(sentences).toEqual(['Hello world.']);
    });

    it('leaves remainder in buffer (no premature emit)', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      chunker.addToken('Hello world. Next');
      // "Next" has no boundary yet
      expect(sentences).toEqual(['Hello world.']);
      // flush emits the remainder
      chunker.flush();
      expect(sentences).toEqual(['Hello world.', 'Next']);
    });
  });

  describe('flush', () => {
    it('emits remaining buffer content', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      chunker.addToken('No boundary here');
      chunker.flush();
      expect(sentences).toEqual(['No boundary here']);
    });

    it('does not emit empty string on flush of empty buffer', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      chunker.flush();
      expect(sentences).toHaveLength(0);
    });

    it('does not emit whitespace-only remainder', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      chunker.addToken('Hello. '); // sentence emitted, buffer = ''
      chunker.flush();
      expect(sentences).toEqual(['Hello.']);
    });

    it('clears the buffer after flush', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      chunker.addToken('Hello');
      chunker.flush();
      chunker.flush(); // second flush should not double-emit
      expect(sentences).toEqual(['Hello']);
    });
  });

  describe('reset', () => {
    it('discards buffer without emitting (barge-in behaviour)', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      chunker.addToken('Half a sentence');
      chunker.reset();
      chunker.flush(); // should be silent
      expect(sentences).toHaveLength(0);
    });

    it('allows new sentences to be accumulated after reset', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      chunker.addToken('Old content');
      chunker.reset();
      chunker.addToken('New sentence. ');
      expect(sentences).toEqual(['New sentence.']);
    });
  });

  describe('full streaming simulation', () => {
    it('correctly chunks a multi-sentence streaming response', () => {
      const chunker = new TextChunker();
      const sentences = collectSentences(chunker);

      // Simulate token-by-token streaming
      const tokens = [
        'Can',
        ' you',
        ' explain',
        ' the',
        ' concept',
        '?',
        ' Sure',
        ',',
        ' I',
        ' think',
        ' it',
        ' means',
        ' X',
        '.',
        ' What',
        ' else',
        '?',
      ];

      for (const token of tokens) {
        chunker.addToken(token);
      }
      chunker.flush();

      expect(sentences).toEqual(['Can you explain the concept?', 'Sure, I think it means X.', 'What else?']);
    });
  });
});
