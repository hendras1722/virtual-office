import type { Agent, AgentCharacter } from './types'

export const SKIN_TONES = ['#f1c9a5', '#e2b899', '#d3a37c', '#b98059', '#8d5b3f', '#6f452f']
export const HAIR_COLORS = ['#2b2420', '#51473e', '#7a5a3c', '#a87b4a', '#c9a063', '#8a3b2a', '#3f3f4a', '#b9b6ae']
export const HAIR_STYLES = ['Pendek', 'Bob', 'Cepol', 'Keriting', 'Kuncir']

function hashId(id: string): number {
  let hash = 2166136261
  for (const char of id) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619)
  hash ^= hash >>> 15
  return Math.imul(hash, 2246822519) >>> 0
}

/** Stable look for agents that never picked one: the same id always gets the same face and hair. */
export function characterFromId(id: string): AgentCharacter {
  const hash = hashId(id)
  return {
    skin: hash % SKIN_TONES.length,
    hairColor: (hash >>> 4) % HAIR_COLORS.length,
    hairStyle: (hash >>> 8) % HAIR_STYLES.length,
    glasses: (hash >>> 12) % 4 === 0,
    hood: (hash >>> 15) % 4 === 0,
  }
}

/** Ready-made characters offered in the agent form; any full valid look is still accepted by the API. */
export const CHARACTER_PRESETS: AgentCharacter[] = [
  { skin: 2, hairStyle: 0, hairColor: 0, glasses: false, hood: false },
  { skin: 1, hairStyle: 4, hairColor: 1, glasses: false, hood: false },
  { skin: 4, hairStyle: 3, hairColor: 0, glasses: true, hood: false },
  { skin: 3, hairStyle: 1, hairColor: 0, glasses: false, hood: false },
  { skin: 0, hairStyle: 0, hairColor: 3, glasses: true, hood: true },
  { skin: 2, hairStyle: 2, hairColor: 5, glasses: false, hood: false },
  { skin: 5, hairStyle: 0, hairColor: 6, glasses: false, hood: true },
  { skin: 0, hairStyle: 1, hairColor: 4, glasses: true, hood: false },
  { skin: 3, hairStyle: 3, hairColor: 1, glasses: false, hood: true },
  { skin: 1, hairStyle: 4, hairColor: 5, glasses: true, hood: false },
  { skin: 4, hairStyle: 0, hairColor: 2, glasses: false, hood: false },
  { skin: 2, hairStyle: 2, hairColor: 7, glasses: true, hood: false },
]

export function lookKey({ skin, hairStyle, hairColor, glasses, hood }: AgentCharacter): string {
  return `${skin}.${hairStyle}.${hairColor}.${Number(glasses)}.${Number(hood)}`
}

function inRange(value: unknown, length: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < length
}

/** Strict validation shared by the API and the stored value; returns null for anything that is not a full valid look. */
export function parseCharacter(value: unknown): AgentCharacter | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { skin, hairStyle, hairColor, glasses, hood } = value as Record<string, unknown>
  if (!inRange(skin, SKIN_TONES.length) || !inRange(hairStyle, HAIR_STYLES.length) || !inRange(hairColor, HAIR_COLORS.length)) return null
  if (typeof glasses !== 'boolean' || typeof hood !== 'boolean') return null
  return { skin, hairStyle, hairColor, glasses, hood }
}

export function resolveCharacter(agent: Pick<Agent, 'id' | 'character'>): AgentCharacter {
  return agent.character ?? characterFromId(agent.id)
}

/** Changes whenever the visible look of an agent changes. */
export function characterKey(agent: Pick<Agent, 'id' | 'character'>): string {
  return lookKey(resolveCharacter(agent))
}
