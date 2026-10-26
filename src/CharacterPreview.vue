<script setup lang="ts">
import { HAIR_COLORS, SKIN_TONES } from './character'
import type { AgentCharacter } from './types'

defineProps<{ character: AgentCharacter; shirt: string }>()
</script>

<template>
  <svg class="character-preview" viewBox="0 0 100 100" role="img" aria-label="Pratinjau karakter">
    <rect width="100" height="100" rx="18" fill="#eef0e6" />
    <ellipse cx="50" cy="104" rx="38" ry="26" :fill="shirt" />
    <ellipse v-if="character.hood" cx="50" cy="76" rx="24" ry="9" :fill="shirt" opacity=".75" />
    <path d="M42 66 Q50 74 58 66 L58 56 L42 56Z" :fill="SKIN_TONES[character.skin]" />
    <ellipse cx="50" cy="75" rx="13" ry="3" fill="#f8f3e9" />
    <g :fill="HAIR_COLORS[character.hairColor]">
      <template v-if="character.hairStyle === 1"><rect x="26" y="34" width="12" height="32" rx="6" /><rect x="62" y="34" width="12" height="32" rx="6" /></template>
      <circle v-if="character.hairStyle === 2" cx="50" cy="17" r="8" />
      <path v-if="character.hairStyle === 4" d="M70 38 Q88 46 80 68 Q74 56 68 48Z" />
      <template v-if="character.hairStyle === 3"><circle cx="33" cy="32" r="11" /><circle cx="50" cy="24" r="13" /><circle cx="67" cy="32" r="11" /><circle cx="27" cy="46" r="8" /><circle cx="73" cy="46" r="8" /></template>
    </g>
    <circle cx="30" cy="46" r="4" :fill="SKIN_TONES[character.skin]" />
    <circle cx="70" cy="46" r="4" :fill="SKIN_TONES[character.skin]" />
    <ellipse cx="50" cy="44" rx="21" ry="23" :fill="SKIN_TONES[character.skin]" />
    <g :fill="HAIR_COLORS[character.hairColor]">
      <path d="M28 44 C26 14 74 14 72 44 C67 32 58 30 50 29 C42 30 33 32 28 44Z" />
      <circle v-if="character.hairStyle === 2" cx="50" cy="24" r="3" :fill="shirt" />
      <circle v-if="character.hairStyle === 4" cx="69" cy="39" r="3" :fill="shirt" />
    </g>
    <ellipse cx="42" cy="46" rx="2.4" ry="3.4" fill="#2f2824" /><ellipse cx="58" cy="46" rx="2.4" ry="3.4" fill="#2f2824" />
    <circle cx="42.8" cy="44.8" r=".8" fill="#fff" /><circle cx="58.8" cy="44.8" r=".8" fill="#fff" />
    <ellipse cx="36" cy="54" rx="4" ry="2.4" fill="#eba39a" opacity=".8" /><ellipse cx="64" cy="54" rx="4" ry="2.4" fill="#eba39a" opacity=".8" />
    <path d="M45 57 Q50 61 55 57" fill="none" stroke="#7a4a42" stroke-width="1.6" stroke-linecap="round" />
    <g v-if="character.glasses" fill="none" stroke="#2f3a38" stroke-width="1.5"><circle cx="42" cy="46" r="6" /><circle cx="58" cy="46" r="6" /><path d="M48 46h4M36 45l-6-1M64 45l6-1" /></g>
  </svg>
</template>

<style scoped>
.character-preview { display: block; width: 100%; height: auto; }
</style>
