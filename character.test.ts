import { expect, test } from 'bun:test'
import { CHARACTER_PRESETS, characterFromId, lookKey, parseCharacter } from './src/character'

test('should offer only valid, distinct preset characters', () => {
  expect(CHARACTER_PRESETS.length).toBeGreaterThanOrEqual(8)
  for (const preset of CHARACTER_PRESETS) expect(parseCharacter(preset)).toEqual(preset)
  expect(new Set(CHARACTER_PRESETS.map(lookKey)).size).toBe(CHARACTER_PRESETS.length)
})

test('should keep the id-derived look stable for agents that never picked a character', () => {
  expect(characterFromId('legacy-agent')).toEqual(characterFromId('legacy-agent'))
  expect(parseCharacter(characterFromId('legacy-agent'))).not.toBeNull()
})
