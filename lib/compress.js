'use strict';

// Minimal, language-independent TextRank (Mihalcea & Tarau, 2004): extracts
// the most important sentences from a text instead of just word-level
// pruning. No POS tags, no stemming, no WordNet - pure word-set overlap
// between sentences, so it works the same for Russian and English input.

const DAMPING = 0.85;
const ITERATIONS = 15;
const MIN_LENGTH_CHARS = 150; // below this, not worth summarizing at all

// Simple splitter: break after . ! ? when followed by whitespace+capital or
// end of string. Not abbreviation-aware - good enough for short memory
// entries, not meant to handle "Mr. Smith" etc.
function splitSentences(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/(?<=[.!?])\s+(?=[A-ZА-ЯЁ]|$)/u);
  return parts.map(s => s.trim()).filter(Boolean);
}

// Most frequent RU/EN function words (articles/prepositions/conjunctions/
// particles/common copula forms). Not a linguistically complete list - just
// enough to stop near-every-sentence "noise" words from inflating similarity
// scores between sentences that share no real content. Bare TextRank without
// this filtering ranks short sentences full of function words as "similar"
// to everything, which pulls unrelated filler sentences into the summary.
const STOP_WORDS = new Set([
  'и', 'в', 'на', 'с', 'по', 'за', 'к', 'от', 'до', 'из', 'у', 'о', 'не', 'но',
  'а', 'что', 'это', 'который', 'как', 'так', 'также', 'кстати', 'очень',
  'быть', 'был', 'была', 'было', 'были', 'сегодня',
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'is', 'was', 'were', 'be', 'been', 'this', 'that', 'today',
]);

const MIN_TOKEN_LENGTH = 3; // extra safety net beyond the stop-word list

// Lowercase, split on non-letter/non-digit runs (unicode-aware so Cyrillic
// splits correctly too), drop empty tokens, drop stop words and very short
// tokens. No stemming/lemmatization.
function tokenize(sentence) {
  return sentence
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(w));
}

// similarity(i, j) = |words_i ∩ words_j| / (log(|words_i|) + log(|words_j|))
// per the original TextRank paper. log(1) = 0, so single-word sentences
// (or the pair being both single-word) would divide by zero - guard with a
// minimum denominator.
function similarity(wordsA, wordsB) {
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const setB = new Set(wordsB);
  let overlap = 0;
  for (const w of new Set(wordsA)) {
    if (setB.has(w)) overlap++;
  }
  const denom = Math.log(wordsA.length) + Math.log(wordsB.length);
  return overlap / (denom || 1); // avoid div-by-zero when both are 1 word
}

function summarize(text, { maxSentences = 2 } = {}) {
  if (!text || text.length < MIN_LENGTH_CHARS) return text;

  const sentences = splitSentences(text);
  if (sentences.length <= maxSentences) return text;

  const wordSets = sentences.map(tokenize);

  // Build similarity matrix.
  const n = sentences.length;
  const sim = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = similarity(wordSets[i], wordSets[j]);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }

  const outSums = sim.map(row => row.reduce((a, b) => a + b, 0));

  let scores = new Array(n).fill(1.0);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const next = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        if (sim[i][j] === 0 || outSums[j] === 0) continue;
        sum += (sim[i][j] * scores[j]) / outSums[j];
      }
      next[i] = (1 - DAMPING) + DAMPING * sum;
    }
    scores = next;
  }

  const topIndices = sentences
    .map((_, i) => i)
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, maxSentences)
    .sort((a, b) => a - b); // restore original reading order

  return topIndices.map(i => sentences[i]).join(' ');
}

module.exports = { summarize };
