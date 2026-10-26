import { expect, test } from 'bun:test'
import { speechChunks, speechText } from './src/useVoiceCall'

test('should drop code, markup and links before reading an answer aloud', () => {
  const spoken = speechText('# Judul\n\nIni **penting** dan `inline`.\n\n```ts\nconst secret = 1\n```\n\nLihat [dokumen](https://example.com/x) atau https://example.com/y.\n- satu\n- dua', 'id-ID')
  expect(spoken).toContain('Judul')
  expect(spoken).toContain('Ini penting dan inline.')
  expect(spoken).toContain('Blok kode dilewati')
  expect(spoken).toContain('Lihat dokumen atau tautan.')
  expect(spoken).toContain('satu dua')
  for (const forbidden of ['const secret', '```', '**', 'https://', '#']) expect(spoken).not.toContain(forbidden)
})

test('should cut very long answers at a word boundary and point to the text', () => {
  const spoken = speechText('kata '.repeat(2000), 'en-US')
  expect(spoken.length).toBeLessThan(1600)
  expect(spoken.endsWith('The rest is in the text.')).toBe(true)
  expect(spoken).not.toMatch(/ka…/)
})

test('should split speech into sentence chunks that stay short enough for the browser', () => {
  const sentence = 'Ini kalimat yang cukup panjang untuk diuji. '
  const chunks = speechChunks(sentence.repeat(40))
  expect(chunks.length).toBeGreaterThan(5)
  expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true)
  expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(sentence.repeat(40).trim())
  expect(speechChunks('   ')).toEqual([])
})
