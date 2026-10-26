import * as THREE from 'three'
import { DEFAULT_SEATS } from './types'
import { characterKey, HAIR_COLORS, resolveCharacter, SKIN_TONES } from './character'
import type { Agent, TaskStatus } from './types'

const palette = {
  floor: '#dcbd94', plank: '#d2b186', edge: '#b99b74', grout: '#b8966c', wall: '#f2e7d4', trim: '#dcc9ad', wainscot: '#a9b99f',
  oak: '#c89f73', oakLight: '#e3c59b', metal: '#e3e0d6', dark: '#49544f', screen: '#abc8bd',
  green: '#68866c', leaf: '#648364', leafLight: '#93a580', pot: '#bd8065', cream: '#f8f3e9',
  rug: '#e0b99a', sofa: '#9cae98', glass: '#c8dedb', sky: '#e8efdf', skin: '#e2b899',
  idle: '#a0b2a4', running: '#dfa75e', completed: '#6e9d7b', failed: '#ce7869',
}

export interface Workstation {
  group: THREE.Group
  occupant: THREE.Group
  body: THREE.Group
  head: THREE.Group
  eyes: THREE.Mesh[]
  eyebrows: THREE.Mesh[]
  mouth: THREE.Mesh
  taskId: string | null
  reactionStartedAt: number | null
  emotionActivity: 'happy' | 'disappointed' | null
  cup: THREE.Group
  idleOffset: number
  idleActivity: 'sleeping' | 'tea' | 'pantry' | 'books' | 'sofa' | null
  away: 'pantry' | 'books' | 'sofa' | null
  steam: THREE.Group
  /** Until when (scene clock, seconds) a freshly poured mug on the desk keeps steaming. */
  steamUntil: number
  arms: THREE.Group[]
  legs: THREE.Group[]
  shirt: THREE.MeshStandardMaterial
  skin: THREE.MeshStandardMaterial
  hair: THREE.MeshStandardMaterial
  hairStyles: THREE.Group[]
  glasses: THREE.Group
  hood: THREE.Mesh
  lookKey: string
  restMouth: THREE.Mesh
  screen: THREE.MeshStandardMaterial
  activity: THREE.Mesh[]
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>
  selection: THREE.Mesh
  anchor: THREE.Vector3
  agentId: string | null
  status: TaskStatus | 'idle'
}

export interface OfficeModel {
  seats: Workstation[]
  setAgent: (seat: Workstation, agent: Agent | undefined) => void
  updateMovement: (delta: number, reducedMotion: boolean) => boolean
  walkTo: (seat: Workstation, destination: 'coffee' | 'water' | 'shelf' | 'sofa') => boolean
  dispose: () => void
  bounds: { minZ: number; maxZ: number }
}

const EYE_HEIGHT = 0.036

function applyAppearance(seat: Workstation, agent: Agent): void {
  const look = resolveCharacter(agent)
  seat.skin.color.set(SKIN_TONES[look.skin]!)
  seat.hair.color.set(HAIR_COLORS[look.hairColor]!)
  seat.hairStyles.forEach((group, index) => { group.visible = index === look.hairStyle })
  seat.glasses.visible = look.glasses
  seat.hood.visible = look.hood
  seat.lookKey = characterKey(agent)
}

const CUP_REST = new THREE.Vector3(0.64, 1.205, 0.45)
// Right palm at rest in arm space, and where it sits on the mug and the mug sits relative to the lips.
const PALM_DIRECTION = new THREE.Vector3(0, -0.255, -0.45).normalize()
const PALM_ON_CUP = new THREE.Vector3(-0.1, -0.01, 0.07)
const CUP_AT_LIPS = new THREE.Vector3(0, -0.095, -0.115)
const scratch = {
  inverse: new THREE.Matrix4(), rest: new THREE.Vector3(), cup: new THREE.Vector3(),
  aim: new THREE.Vector3(), rotation: new THREE.Quaternion(),
}
const { smoothstep, clamp } = THREE.MathUtils
const pulse = (value: number, from: number, to: number): number => Math.sin(Math.PI * clamp((value - from) / (to - from), 0, 1))

export function updateWorkstationAnimation(seat: Workstation, time: number, reducedMotion: boolean): boolean {
  if (seat.away) {
    seat.idleActivity = seat.away
    seat.emotionActivity = null
    return true
  }
  const running = seat.status === 'running'
  const happy = seat.status === 'completed'
  const disappointed = seat.status === 'failed'
  const emotional = happy || disappointed
  if (emotional && seat.reactionStartedAt === null) seat.reactionStartedAt = time
  if (emotional && reducedMotion) seat.reactionStartedAt = time - 7000
  const elapsed = emotional ? (time - seat.reactionStartedAt!) / 1000 : 0
  const reaction = emotional && !reducedMotion ? smoothstep(elapsed, 0, 0.35) * (1 - smoothstep(elapsed, 5, 7)) : 0
  seat.emotionActivity = reaction > 0 ? happy ? 'happy' : 'disappointed' : null
  const seconds = time / 1000 + seat.idleOffset
  const cycle = seconds % 20
  const idle = !running && !reducedMotion && (!emotional || elapsed >= 7)
  const sleep = idle ? smoothstep(cycle, 0, 1) * (1 - smoothstep(cycle, 8, 9)) : 0
  // Tea break: reach for the mug, lift it, sip twice, set it back down, then let go.
  const reach = idle ? smoothstep(cycle, 10, 10.8) * (1 - smoothstep(cycle, 17.6, 18.4)) : 0
  const lift = idle ? smoothstep(cycle, 10.8, 12) * (1 - smoothstep(cycle, 16.4, 17.6)) : 0
  const sip = idle ? pulse(cycle, 12.5, 14) + pulse(cycle, 14.8, 16.2) : 0
  seat.idleActivity = sleep > 0.15 ? 'sleeping' : reach > 0.15 ? 'tea' : null
  // Celebration: arms shoot up and pump while the chair hops and swivels, then settles into a relaxed lean back.
  const cheer = happy ? reaction * smoothstep(elapsed, 0.05, 0.55) * (1 - smoothstep(elapsed, 3.4, 4.6)) : 0
  const relax = happy ? reaction * smoothstep(elapsed, 3.4, 4.4) : 0
  const hopPhase = (elapsed * 1.75) % 1
  const hop = happy ? reaction * smoothstep(elapsed, 0.05, 0.3) * (1 - smoothstep(elapsed, 2.2, 3.2)) * 0.1 * 4 * hopPhase * (1 - hopPhase) : 0
  seat.body.scale.y = reducedMotion ? 1 : 1 + Math.sin(seconds * 1.8) * 0.012
  seat.body.rotation.set(running ? -0.055 : sleep * 0.28 - reach * (1 - lift * 0.6) * 0.06, 0, sleep * 0.13)
  seat.body.position.y = 0.76 + hop + cheer * 0.02
  seat.body.rotation.x += happy ? cheer * 0.08 + relax * 0.1 : reaction * 0.18
  seat.body.rotation.y = happy ? Math.sin(elapsed * 2.4) * 0.3 * cheer : -reaction * 0.8
  const headX = -sleep * 0.55 - reach * (1 - lift) * 0.14 + sip * 0.16
  seat.head.rotation.set(
    headX + (happy ? cheer * (0.2 + Math.sin(elapsed * 11) * 0.035) + relax * 0.05 : disappointed ? -reaction * 0.4 : 0),
    happy ? Math.sin(elapsed * 2.4 + 0.6) * 0.22 * cheer : -reaction * (1.5 + (disappointed ? Math.sin(elapsed * 5) * 0.18 : 0)),
    happy ? Math.sin(elapsed * 2.4) * 0.08 * cheer : 0,
  )
  for (const eye of seat.eyes) eye.scale.y = EYE_HEIGHT * (1 - sleep * 0.9 - sip * 0.45) * (happy ? 0.55 : 1)
  for (let index = 0; index < seat.eyebrows.length; index++) {
    const brow = seat.eyebrows[index]!
    brow.visible = emotional
    brow.rotation.z = (index ? -1 : 1) * (disappointed ? 0.4 : -0.12)
  }
  seat.mouth.visible = emotional
  seat.restMouth.visible = !emotional
  seat.mouth.rotation.z = happy ? Math.PI : 0
  for (let index = 0; index < seat.arms.length; index++) {
    const arm = seat.arms[index]!
    arm.rotation.set(running && !reducedMotion ? Math.sin(seconds * 18 + index * Math.PI) * 0.1 : -sleep * 0.4, 0, 0)
    if (reaction > 0) {
      if (happy) {
        arm.rotation.x = cheer * (2.65 + Math.sin(elapsed * 9 + index * Math.PI) * 0.22)
        arm.rotation.z = cheer * (index ? 0.5 : -0.5)
      } else {
        arm.rotation.x = reaction * (index ? 1.4 : -0.45)
        arm.rotation.z = reaction * (index ? -0.5 : -0.12)
      }
    }
  }
  seat.cup.position.copy(CUP_REST)
  seat.cup.rotation.set(0, 0, 0)
  if (reach > 0) {
    const arm = seat.arms[1]!
    seat.body.updateMatrix()
    seat.head.updateMatrix()
    scratch.inverse.copy(seat.body.matrix).invert()
    scratch.rest.copy(CUP_REST).applyMatrix4(scratch.inverse)
    scratch.cup.set(0, 0.12, -0.257).applyMatrix4(seat.head.matrix).add(CUP_AT_LIPS)
    scratch.cup.lerpVectors(scratch.rest, scratch.cup, lift)
    scratch.cup.y += Math.sin(Math.PI * lift) * 0.04
    scratch.aim.copy(scratch.cup).add(PALM_ON_CUP).sub(arm.position).normalize()
    scratch.rotation.setFromUnitVectors(PALM_DIRECTION, scratch.aim)
    arm.quaternion.slerp(scratch.rotation, reach)
    if (lift > 0) {
      seat.cup.position.copy(scratch.cup).applyMatrix4(seat.body.matrix)
      seat.cup.rotation.x = lift * 0.12 + sip * 0.45
    }
  }
  if (running && !reducedMotion) {
    for (let index = 0; index < seat.activity.length; index++) {
      seat.activity[index]!.scale.x = 0.65 + Math.sin(seconds * 3 + index) * 0.22
    }
  }
  return (running && !reducedMotion) || reaction > 0 || sleep > 0 || reach > 0
}

export function createOffice(scene: THREE.Scene, seatCount = DEFAULT_SEATS): OfficeModel {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1)
  const cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 16)
  const sphereGeometry = new THREE.SphereGeometry(1, 16, 12)
  const leafGeometry = new THREE.SphereGeometry(1, 10, 8)
  const ringGeometry = new THREE.TorusGeometry(0.53, 0.025, 8, 40)
  const cupHandleGeometry = new THREE.TorusGeometry(0.075, 0.02, 6, 12)
  const mouthGeometry = new THREE.TorusGeometry(0.07, 0.012, 4, 16, Math.PI)
  geometries.add(mouthGeometry)
  geometries.add(cupHandleGeometry)
  const rimGeometry = new THREE.TorusGeometry(1, 0.12, 6, 20)
  const collarGeometry = new THREE.TorusGeometry(1, 0.3, 8, 24)
  geometries.add(boxGeometry).add(cylinderGeometry).add(sphereGeometry).add(leafGeometry).add(ringGeometry).add(rimGeometry).add(collarGeometry)
  const materialCache = new Map<string, THREE.MeshStandardMaterial>()

  function material(color: string, roughness = 0.78): THREE.MeshStandardMaterial {
    const existing = materialCache.get(color)
    if (existing) return existing
    const result = new THREE.MeshStandardMaterial({ color, roughness })
    materials.add(result)
    materialCache.set(color, result)
    return result
  }

  function mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, color: string | THREE.Material, position: [number, number, number], scale: [number, number, number]): THREE.Mesh {
    const result = new THREE.Mesh(geometry, typeof color === 'string' ? material(color) : color)
    result.position.set(...position)
    result.scale.set(...scale)
    result.castShadow = true
    result.receiveShadow = true
    parent.add(result)
    return result
  }

  function box(parent: THREE.Object3D, color: string, x: number, y: number, z: number, w: number, h: number, d: number): THREE.Mesh {
    return mesh(parent, boxGeometry, color, [x, y, z], [w, h, d])
  }

  function cylinder(parent: THREE.Object3D, color: string, x: number, y: number, z: number, radius: number, height: number): THREE.Mesh {
    return mesh(parent, cylinderGeometry, color, [x, y, z], [radius, height, radius])
  }

  function plant(parent: THREE.Object3D, x: number, z: number, size = 1, elevation = 0): void {
    const group = new THREE.Group()
    group.position.set(x, elevation, z)
    group.scale.setScalar(size)
    parent.add(group)
    cylinder(group, palette.pot, 0, 0.24, 0, 0.29, 0.48)
    cylinder(group, palette.dark, 0, 0.49, 0, 0.25, 0.025)
    for (let i = 0; i < 7; i++) {
      const angle = (i / 7) * Math.PI * 2
      const height = 0.78 + (i % 3) * 0.16
      const leaf = mesh(group, leafGeometry, i % 2 ? palette.leaf : palette.leafLight,
        [Math.cos(angle) * 0.21, height, Math.sin(angle) * 0.21], [0.15, 0.46, 0.12])
      leaf.rotation.set(Math.sin(angle) * 0.45, angle, Math.cos(angle) * -0.45)
    }
  }

  // Three desks per row; rows past the fourth push the front of the room out so every desk fits.
  const rows = Math.ceil(seatCount / 3)
  const extra = Math.max(0, rows - 4) * 3.05
  const room = new THREE.Group()
  scene.add(room)
  box(room, palette.edge, 0, -0.22, extra / 2, 18.4, 0.4, 15.4 + extra)
  box(room, palette.grout, 0, 0, extra / 2, 18, 0.06, 15 + extra)
  const planks = Math.ceil((15 + extra) / 0.5)
  const pitch = (15 + extra) / planks
  for (let i = 0; i < planks; i++) {
    const z = -7.5 + (i + 0.5) * pitch
    box(room, i % 2 ? palette.plank : palette.floor, 0, 0.035, z, 18, 0.01, pitch - 0.04)
    for (const offset of [0, 6, 12]) box(room, palette.grout, ((i * 7 + offset) % 18) - 8.5, 0.037, z, 0.025, 0.008, pitch - 0.04)
  }

  box(room, palette.wall, 0, 1.7, -7.45, 18.2, 3.4, 0.18)
  // Leave a real doorway for departing characters.
  box(room, palette.wall, -9.05, 1.7, -1.9, 0.18, 3.4, 11.2)
  box(room, palette.wall, -9.05, 1.7, 6.4, 0.18, 3.4, 2.2)
  if (extra > 0) box(room, palette.wall, -9.05, 1.7, 7.5 + extra / 2, 0.18, 3.4, extra)
  box(room, palette.wall, -9.05, 3.15, 4.5, 0.18, 0.5, 1.6)
  box(room, palette.trim, 0, 0.17, -7.31, 18, 0.25, 0.1)
  box(room, palette.trim, -8.92, 0.17, -1.9, 0.1, 0.25, 11.2)
  box(room, palette.trim, -8.92, 0.17, 6.4, 0.1, 0.25, 2.2)
  if (extra > 0) box(room, palette.trim, -8.92, 0.17, 7.5 + extra / 2, 0.1, 0.25, extra)
  box(room, palette.cream, 0, 3.43, -7.45, 18.3, 0.1, 0.27)
  box(room, palette.cream, -9.05, 3.43, extra / 2, 0.27, 0.1, 15.2 + extra)
  // Two-tone walls: a sage wainscot under the warm plaster keeps the room from reading as one flat box.
  box(room, palette.wainscot, 0, 0.62, -7.3, 18, 0.655, 0.05)
  box(room, palette.wainscot, -8.9, 0.62, -1.8, 0.05, 0.655, 10.75)
  box(room, palette.wainscot, -8.9, 0.62, 6.45 + extra / 2, 0.05, 0.655, 1.9 + extra)
  box(room, palette.cream, 0, 0.96, -7.29, 18, 0.05, 0.07)

  for (const x of [-5.2, 0, 5.2]) {
    box(room, palette.trim, x, 2.05, -7.28, 3.7, 2.2, 0.12)
    box(room, palette.glass, x, 2.05, -7.19, 3.42, 1.94, 0.055)
    box(room, palette.sky, x - 0.9, 2.25, -7.15, 1.45, 1.45, 0.025)
    box(room, palette.cream, x, 2.05, -7.11, 0.07, 2, 0.06)
    box(room, palette.cream, x, 2.05, -7.1, 3.45, 0.07, 0.07)
    box(room, palette.oakLight, x, 0.99, -7.08, 3.95, 0.12, 0.42)
  }

  // The door swings outward so the aisle stays clear.
  for (const z of [3.7, 5.35]) box(room, palette.trim, -8.9, 1.42, z, 0.2, 2.85, 0.12)
  box(room, palette.trim, -8.9, 2.84, 4.525, 0.2, 0.12, 1.77)
  const door = new THREE.Group()
  door.position.set(-8.95, 0, 3.75)
  room.add(door)
  box(door, palette.oakLight, 0, 1.4, 0.77, 0.09, 2.66, 1.42)
  box(door, palette.glass, 0.07, 1.85, 0.77, 0.03, 1.24, 1.08)
  box(door, palette.dark, 0.13, 1.14, 1.25, 0.08, 0.06, 0.22)
  box(room, palette.trim, -8.88, 2.04, -2.7, 0.1, 1.8, 4.6)
  box(room, palette.glass, -8.79, 2.04, -2.7, 0.05, 1.57, 4.35)
  for (const z of [-4.1, -2.7, -1.3]) box(room, palette.cream, -8.74, 2.04, z, 0.06, 1.62, 0.07)
  box(room, palette.oakLight, -8.68, 1.1, -2.7, 0.4, 0.1, 4.75)
  plant(room, -8.4, 2.6, 1.0)
  plant(room, -8.3, 6.35, 1.05)
  plant(room, 7.7, -6.2, 1.15)

  // A quiet lounge occupies its own strip, leaving the full twelve-desk grid open.
  box(room, palette.rug, 6.65, 0.055, 2.95, 3.55, 0.04, 5.75)
  for (const x of [5.1, 8.2]) box(room, palette.cream, x, 0.08, 2.95, 0.035, 0.01, 5.3)
  const sofa = new THREE.Group()
  sofa.position.set(7.55, 0, 2.55)
  sofa.rotation.y = -Math.PI / 2
  sofa.scale.y = 0.62
  room.add(sofa)
  box(sofa, palette.sofa, 0, 0.55, -0.2375, 2.65, 0.5, 0.675)
  box(sofa, palette.sofa, 0, 1.05, -0.47, 2.7, 0.88, 0.25)
  for (const x of [-1.24, 1.24]) box(sofa, palette.sofa, x, 0.85, 0, 0.24, 0.7, 1.14)
  for (const x of [-0.8, 0, 0.8]) box(sofa, '#b2beaa', x, 0.85, 0.04, 0.73, 0.16, 0.89)
  const pillow = box(sofa, '#e0c399', -0.88, 1.18, -0.18, 0.54, 0.53, 0.18)
  pillow.rotation.z = -0.17
  // Only the back feet: the front of the seat overhangs so a seated character's lower legs hang free in front.
  for (const x of [-1, 1]) cylinder(sofa, palette.oak, x, 0.18, -0.35, 0.065, 0.25)
  cylinder(room, palette.oakLight, 5.4, 0.62, 2.7, 0.66, 0.12)
  cylinder(room, palette.oak, 5.4, 0.32, 2.7, 0.11, 0.57)
  cylinder(room, palette.oak, 5.4, 0.065, 2.7, 0.44, 0.09)
  box(room, palette.cream, 5.25, 0.705, 2.69, 0.48, 0.055, 0.35).rotation.y = 0.17
  cylinder(room, palette.pot, 5.64, 0.76, 2.59, 0.1, 0.17)
  plant(room, 7.65, 5.65, 0.9)

  const shelf = new THREE.Group()
  shelf.position.set(6.25, 0, -5.4)
  room.add(shelf)
  for (const x of [-1.25, 1.25]) box(shelf, palette.oak, x, 1.17, 0, 0.12, 2.34, 0.6)
  for (const y of [0.15, 0.9, 1.65, 2.38]) box(shelf, palette.oakLight, 0, y, 0, 2.65, 0.1, 0.66)
  const bookColors = ['#7f998b', '#c38e72', '#d2bc8c', '#9d9bb1', '#e7dfc8']
  for (let i = 0; i < 14; i++) {
    const row = i % 2
    box(shelf, bookColors[i % bookColors.length]!, -1.06 + Math.floor(i / 2) * 0.22, 0.47 + row * 0.75, 0.02, 0.14, 0.52 - (i % 3) * 0.06, 0.36)
  }
  plant(shelf, 0.78, 0, 0.45, 1.71)
  box(shelf, palette.cream, -0.64, 1.91, 0.08, 0.64, 0.42, 0.43)
  box(shelf, palette.oak, -0.64, 1.95, 0.305, 0.23, 0.045, 0.025)
  plant(room, 7.6, -2.9, 0.7)

  const glow = new THREE.MeshStandardMaterial({ color: '#fff0cc', emissive: '#ffc470', emissiveIntensity: 1.2, roughness: 0.5 })
  materials.add(glow)
  for (const [x, background, accent, detail] of [[-2.6, '#e6c27a', '#c9785c', '#8fa58a'], [2.6, '#9fb5a4', '#f4e4c8', '#d58f6c']] as const) {
    box(room, palette.cream, x, 2.1, -7.3, 1.1, 1.5, 0.05)
    box(room, background, x, 2.1, -7.27, 0.9, 1.3, 0.03)
    cylinder(room, accent, x, 2.3, -7.24, 0.28, 0.02).rotation.x = Math.PI / 2
    box(room, detail, x, 1.72, -7.24, 0.64, 0.2, 0.02)
  }
  cylinder(room, palette.oak, 8.05, 2.5, -7.3, 0.47, 0.05).rotation.x = Math.PI / 2
  cylinder(room, palette.cream, 8.05, 2.5, -7.27, 0.42, 0.04).rotation.x = Math.PI / 2
  box(room, palette.dark, 8.05, 2.62, -7.24, 0.03, 0.24, 0.015)
  box(room, palette.dark, 8.14, 2.5, -7.24, 0.2, 0.03, 0.015)
  box(room, palette.oak, -8.9, 2.1, 1.6, 0.08, 1.1, 1.8)
  box(room, '#c9a074', -8.86, 2.1, 1.6, 0.05, 0.96, 1.66)
  for (const [index, color] of ['#f3d36b', '#f0a7a0', '#a9d0bd', '#f3d36b', '#b8c7ec', '#f0a7a0', '#a9d0bd'].entries()) {
    const note = box(room, color, -8.82, 2.5 - Math.floor(index / 3) * 0.36, 0.95 + (index % 3) * 0.55, 0.02, 0.24, 0.24)
    note.rotation.x = (index % 2 ? 1 : -1) * (0.05 + index * 0.02)
  }
  // Warm string lights draped along the back wall.
  const bulbs: THREE.Vector3[] = []
  for (let i = 0; i <= 28; i++) {
    const t = i / 28
    bulbs.push(new THREE.Vector3(-8.7 + t * 17.4, 3.3 - Math.sin((t * 4 % 1) * Math.PI) * 0.22, -7.1))
  }
  for (let i = 0; i < bulbs.length; i++) {
    const bulb = bulbs[i]!
    mesh(room, sphereGeometry, glow, [bulb.x, bulb.y - 0.05, bulb.z + 0.02], [0.055, 0.07, 0.055])
    const next = bulbs[i + 1]
    if (next) box(room, '#4b4a45', (bulb.x + next.x) / 2, (bulb.y + next.y) / 2, bulb.z, Math.hypot(next.x - bulb.x, next.y - bulb.y), 0.012, 0.012)
      .rotation.z = Math.atan2(next.y - bulb.y, next.x - bulb.x)
  }
  // Lounge extras: floor lamp, bean bag, pouf and a second pillow.
  cylinder(room, palette.dark, 8.5, 0.03, 0.8, 0.2, 0.05)
  cylinder(room, palette.dark, 8.5, 0.85, 0.8, 0.025, 1.6)
  mesh(room, cylinderGeometry, glow, [8.5, 1.78, 0.8], [0.3, 0.36, 0.3])
  mesh(room, sphereGeometry, '#d79b7d', [6.1, 0.38, 4.6], [0.58, 0.4, 0.55])
  cylinder(room, '#e3c27a', 5.3, 0.2, 4.35, 0.3, 0.36)
  const pillowTwo = box(sofa, '#d79b7d', 0.92, 1.17, -0.2, 0.5, 0.48, 0.18)
  pillowTwo.rotation.z = 0.15

  // Pantry along the left wall: a counter with a coffee machine, and a water dispenser beside it.
  box(room, palette.oak, -8.55, 0.47, -6.475, 0.62, 0.94, 0.95)
  box(room, palette.oakLight, -8.55, 0.965, -6.475, 0.66, 0.05, 1.0)
  for (const z of [-6.75, -6.2]) box(room, palette.dark, -8.235, 0.5, z, 0.012, 0.74, 0.4)
  box(room, '#dfe8e2', -8.85, 1.4, -6.475, 0.02, 0.55, 1.0)
  box(room, palette.cream, -8.7, 2.3, -6.475, 0.34, 0.7, 1.15)
  for (const z of [-6.75, -6.2]) box(room, palette.oak, -8.525, 2.3, z, 0.012, 0.6, 0.5)
  box(room, palette.dark, -8.62, 1.2, -6.5, 0.32, 0.44, 0.3)
  box(room, '#2f3a38', -8.62, 1.44, -6.5, 0.28, 0.05, 0.26)
  box(room, '#2f3a38', -8.4, 1.17, -6.5, 0.14, 0.05, 0.14)
  box(room, '#c9cec3', -8.38, 0.99, -6.5, 0.2, 0.02, 0.18)
  const ledMaterial = new THREE.MeshStandardMaterial({ color: '#7fd18b', emissive: '#43c463', emissiveIntensity: 0.6, roughness: 0.5 })
  materials.add(ledMaterial)
  mesh(room, sphereGeometry, ledMaterial, [-8.455, 1.34, -6.4], [0.018, 0.018, 0.018])
  for (const z of [-6.85, -6.78]) cylinder(room, z === -6.85 ? palette.cream : '#e8b7a0', -8.5, 1.03, z, 0.04, 0.08)
  const coffeeStream = cylinder(room, '#5a3b2a', -8.36, 1.1, -6.5, 0.012, 0.12)
  coffeeStream.visible = false
  box(room, '#e9ece8', -8.62, 0.525, -5.62, 0.36, 1.05, 0.36)
  cylinder(room, '#bfe0ec', -8.62, 1.28, -5.62, 0.15, 0.45)
  cylinder(room, '#e9ece8', -8.62, 1.52, -5.62, 0.05, 0.04)
  box(room, '#d9695a', -8.4, 1.12, -5.68, 0.1, 0.04, 0.05)
  box(room, '#5a8fb0', -8.4, 1.12, -5.56, 0.1, 0.04, 0.05)
  box(room, '#c9cec3', -8.38, 0.99, -5.62, 0.2, 0.02, 0.2)
  const waterStream = cylinder(room, '#9fd3ea', -8.36, 1.06, -5.56, 0.01, 0.1)
  waterStream.visible = false

  const rowShift = (row: number): number => (row % 2 ? 0.45 : -0.45)
  const rugColors = ['#b9c7a8', '#e2b3a0']
  for (let row = 0; row < rows; row++) {
    const z = -4.85 + row * 3.05 + 0.45
    const columns = Math.min(3, seatCount - row * 3)
    const x = -5.55 + (columns - 1) * 1.8 + rowShift(row)
    box(room, palette.cream, x, 0.04, z, columns * 3.6, 0.02, 2.75)
    box(room, rugColors[row % 2]!, x, 0.043, z, columns * 3.6 - 0.3, 0.02, 2.45)
  }
  const seats: Workstation[] = []
  // Steam: soft puffs rising from a hot mug. The same helper animates desk mugs and the copies characters carry.
  const STEAM_PUFFS = 3
  const STEAM_SECONDS = 40
  const steamMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false })
  materials.add(steamMaterial)
  const coffeeMaterial = material('#6e5544')
  const AXIS_X = new THREE.Vector3(1, 0, 0)
  const tilt = new THREE.Quaternion()
  function makeSteam(cup: THREE.Group): THREE.Group {
    const steam = new THREE.Group()
    steam.name = 'steam'
    steam.visible = false
    for (let index = 0; index < STEAM_PUFFS; index++) steam.add(new THREE.Mesh(sphereGeometry, steamMaterial))
    cup.add(steam)
    return steam
  }
  function animateSteam(steam: THREE.Object3D, time: number, on: boolean): void {
    steam.visible = on
    if (!on) return
    steam.children.forEach((puff, index) => {
      const age = (time * 0.4 + index / STEAM_PUFFS) % 1
      puff.position.set(Math.sin(time * 2 + index * 2.1) * 0.03 * age, 0.15 + age * 0.34, Math.cos(time * 1.7 + index * 1.3) * 0.025 * age)
      puff.scale.setScalar(0.01 + 0.04 * Math.sin(Math.PI * age))
    })
  }
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < Math.min(3, seatCount - row * 3); column++) {
      const group = new THREE.Group()
      group.userData.workstation = true
      group.position.set(-5.55 + column * 3.6 + rowShift(row), 0, -4.85 + row * 3.05)
      room.add(group)
      box(group, palette.oakLight, 0, 1.02, 0, 2.35, 0.13, 1.16)
      box(group, palette.oak, 0, 0.92, -0.4, 2.2, 0.1, 0.08)
      for (const x of [-0.97, 0.97]) {
        for (const z of [-0.42, 0.42]) box(group, palette.metal, x, 0.5, z, 0.065, 0.96, 0.065)
        box(group, palette.metal, x, 0.08, 0, 0.13, 0.08, 1.08)
      }
      box(group, palette.dark, 0, 1.16, -0.25, 0.43, 0.055, 0.29)
      box(group, palette.dark, 0, 1.35, -0.35, 0.065, 0.37, 0.065)
      box(group, palette.dark, 0, 1.65, -0.36, 1.08, 0.67, 0.075)
      const screenMaterial = new THREE.MeshStandardMaterial({ color: palette.screen, emissive: palette.screen, emissiveIntensity: 0.12, roughness: 0.45 })
      materials.add(screenMaterial)
      const screen = new THREE.Mesh(boxGeometry, screenMaterial)
      screen.position.set(0, 1.65, -0.313)
      screen.scale.set(0.96, 0.55, 0.012)
      group.add(screen)
      const activity: THREE.Mesh[] = []
      for (let line = 0; line < 4; line++) {
        activity.push(box(group, line % 2 ? '#dcebdd' : '#6d9687', -0.1 + (line % 2) * 0.08, 1.82 - line * 0.11, -0.3, 0.54 - (line % 3) * 0.12, 0.035, 0.012))
      }
      box(group, palette.cream, 0, 1.11, 0.25, 0.78, 0.055, 0.27)
      for (let keyRow = 0; keyRow < 3; keyRow++) {
        box(group, '#c9cec3', 0, 1.143, 0.17 + keyRow * 0.07, 0.64, 0.01, 0.014)
      }
      mesh(group, sphereGeometry, palette.cream, [0.5, 1.12, 0.1], [0.09, 0.035, 0.13])
      if ((row + column) % 3 === 0) plant(group, -0.91, -0.27, 0.27, 1.08)
      const index = row * 3 + column
      if (index % 3 === 1) {
        cylinder(group, palette.dark, -0.88, 1.105, -0.2, 0.09, 0.03)
        cylinder(group, palette.dark, -0.88, 1.29, -0.2, 0.012, 0.35)
        mesh(group, sphereGeometry, '#e3c27a', [-0.88, 1.5, -0.2], [0.11, 0.07, 0.11])
      }
      if (index % 2 === 0) {
        const note = box(group, ['#f3d36b', '#f0a7a0', '#a9d0bd'][index % 3]!, 0.47, 1.87, -0.31, 0.11, 0.11, 0.012)
        note.rotation.z = 0.12
      }
      if (index % 4 === 2) {
        box(group, '#c38e72', -0.9, 1.12, 0.1, 0.3, 0.06, 0.22)
        box(group, '#7f998b', -0.9, 1.175, 0.1, 0.26, 0.05, 0.19).rotation.y = 0.2
      }
      const mugColor = ['#f8f3e9', '#e7b7a0', '#a9c4bf', '#e8cf8a'][index % 4]!
      const chairColor = ['#828e84', '#c58f6f', '#d3b25f', '#7d9aa6', '#b97d86', '#8f8aa8'][index % 6]!
      const cup = new THREE.Group()
      cup.position.copy(CUP_REST)
      group.add(cup)
      cylinder(cup, mugColor, 0, 0, 0, 0.12, 0.24)
      cylinder(cup, '#6e5544', 0, 0.121, 0, 0.1, 0.009)
      mesh(cup, cupHandleGeometry, mugColor, [0.13, 0, 0], [1, 1, 1])
      const steam = makeSteam(cup)
      box(group, '#dfd7c1', 0.9, 1.115, -0.2, 0.27, 0.06, 0.38).rotation.y = -0.12
      cylinder(group, palette.dark, 0, 0.31, 1, 0.055, 0.55)
      for (let leg = 0; leg < 5; leg++) {
        const spoke = box(group, palette.dark, 0, 0.12, 1, 0.8, 0.045, 0.05)
        spoke.rotation.y = leg * Math.PI / 5
      }
      box(group, chairColor, 0, 0.64, 1, 0.74, 0.16, 0.67)
      box(group, chairColor, 0, 1.08, 1.31, 0.73, 0.8, 0.13)
      for (const x of [-0.42, 0.42]) box(group, palette.dark, x, 0.92, 1, 0.065, 0.08, 0.44)

      const occupant = new THREE.Group()
      group.add(occupant)
      const body = new THREE.Group()
      body.position.set(0, 0.76, 0.93)
      occupant.add(body)
      const shirt = new THREE.MeshStandardMaterial({ color: '#a38fba', roughness: 0.85 })
      const skin = new THREE.MeshStandardMaterial({ color: SKIN_TONES[0], roughness: 0.7 })
      const hair = new THREE.MeshStandardMaterial({ color: HAIR_COLORS[0], roughness: 0.6 })
      materials.add(shirt).add(skin).add(hair)
      mesh(body, sphereGeometry, shirt, [0, 0.37, 0], [0.3, 0.41, 0.22])
      mesh(body, sphereGeometry, skin, [0, 0.77, -0.015], [0.085, 0.1, 0.085])
      const collar = mesh(body, collarGeometry, palette.cream, [0, 0.715, -0.015], [0.115, 0.115, 0.115])
      collar.rotation.x = Math.PI / 2
      const hood = mesh(body, sphereGeometry, shirt, [0, 0.7, 0.1], [0.2, 0.1, 0.15])
      const head = new THREE.Group()
      head.position.y = 0.82
      body.add(head)
      mesh(head, sphereGeometry, skin, [0, 0.2, -0.035], [0.235, 0.265, 0.235])
      mesh(head, sphereGeometry, skin, [0, 0.11, -0.065], [0.19, 0.16, 0.19])
      for (const side of [-1, 1]) {
        mesh(head, sphereGeometry, skin, [side * 0.228, 0.18, -0.035], [0.05, 0.07, 0.045])
        mesh(head, sphereGeometry, '#eba39a', [side * 0.135, 0.135, -0.208], [0.045, 0.028, 0.012]).rotation.y = -side * 0.5
      }
      mesh(head, sphereGeometry, skin, [0, 0.165, -0.262], [0.03, 0.027, 0.03])
      const eyes = [-0.09, 0.09].map((x) => {
        const eye = mesh(head, sphereGeometry, '#2f2824', [x, 0.215, -0.25], [0.027, EYE_HEIGHT, 0.014])
        mesh(eye, sphereGeometry, '#ffffff', [0.3, 0.4, -0.75], [0.3, 0.3, 0.3])
        return eye
      })
      const eyebrows = [-0.09, 0.09].map((x) => box(head, '#2f2824', x, 0.275, -0.243, 0.065, 0.018, 0.02))
      for (const brow of eyebrows) brow.material = hair
      const mouth = mesh(head, mouthGeometry, '#7a4a42', [0, 0.115, -0.257], [1, 1, 1])
      const restMouth = mesh(head, mouthGeometry, '#7a4a42', [0, 0.132, -0.256], [0.45, 0.45, 1])
      restMouth.rotation.z = Math.PI
      for (const brow of eyebrows) brow.visible = false
      mouth.visible = false
      const glasses = new THREE.Group()
      head.add(glasses)
      for (const x of [-0.09, 0.09]) {
        mesh(glasses, rimGeometry, '#2f3a38', [x, 0.215, -0.262], [0.058, 0.058, 0.058])
        const temple = box(glasses, '#2f3a38', x * 2.1, 0.222, -0.15, 0.008, 0.008, 0.22)
        temple.rotation.y = Math.sign(x) * 0.34
      }
      box(glasses, '#2f3a38', 0, 0.222, -0.262, 0.05, 0.008, 0.008)
      const hairStyles = [0, 1, 2, 3, 4].map(() => {
        const group = new THREE.Group()
        head.add(group)
        return group
      })
      const strand = (group: THREE.Group, position: [number, number, number], scale: [number, number, number]): THREE.Mesh =>
        mesh(group, sphereGeometry, hair, position, scale)
      for (const [index, group] of hairStyles.entries()) {
        if (index !== 3) {
          strand(group, [0, 0.285, 0.012], [0.245, 0.2, 0.245])
          strand(group, [0, 0.355, -0.15], [0.19, 0.075, 0.1]).rotation.x = 0.3
        }
      }
      strand(hairStyles[0]!, [0, 0.17, 0.075], [0.2, 0.17, 0.15])
      strand(hairStyles[1]!, [0, 0.12, 0.07], [0.245, 0.23, 0.19])
      for (const side of [-1, 1]) strand(hairStyles[1]!, [side * 0.2, 0.14, -0.02], [0.06, 0.19, 0.16])
      strand(hairStyles[2]!, [0, 0.17, 0.075], [0.2, 0.17, 0.15])
      strand(hairStyles[2]!, [0, 0.49, 0.08], [0.095, 0.095, 0.095])
      mesh(hairStyles[2]!, sphereGeometry, shirt, [0, 0.44, 0.07], [0.1, 0.03, 0.1])
      strand(hairStyles[3]!, [0, 0.31, 0.02], [0.29, 0.26, 0.285])
      strand(hairStyles[3]!, [0, 0.5, 0], [0.14, 0.1, 0.14])
      for (const side of [-1, 1]) {
        strand(hairStyles[3]!, [side * 0.17, 0.42, -0.02], [0.12, 0.12, 0.12])
        strand(hairStyles[3]!, [side * 0.24, 0.22, 0.06], [0.08, 0.12, 0.1])
      }
      strand(hairStyles[3]!, [0, 0.2, 0.16], [0.2, 0.2, 0.12])
      strand(hairStyles[4]!, [0, 0.17, 0.075], [0.2, 0.17, 0.15])
      mesh(hairStyles[4]!, sphereGeometry, shirt, [0, 0.27, 0.235], [0.065, 0.065, 0.065])
      strand(hairStyles[4]!, [0, 0.17, 0.3], [0.07, 0.14, 0.07]).rotation.x = -0.3
      strand(hairStyles[4]!, [0, 0.03, 0.34], [0.06, 0.1, 0.06])
      const legs: THREE.Group[] = []
      for (const x of [-0.15, 0.15]) {
        const leg = new THREE.Group()
        leg.position.set(x, 0.08, 0)
        leg.rotation.x = Math.PI / 2
        body.add(leg)
        box(leg, '#4d5a63', 0, -0.15, 0, 0.23, 0.3, 0.22)
        const shin = new THREE.Group()
        shin.position.y = -0.3
        shin.rotation.x = -Math.PI / 2
        leg.add(shin)
        box(shin, '#4d5a63', 0, -0.22, 0, 0.18, 0.44, 0.19)
        mesh(shin, sphereGeometry, '#8a7868', [0, -0.47, -0.08], [0.115, 0.07, 0.19])
        box(shin, palette.cream, 0, -0.51, -0.08, 0.215, 0.03, 0.36)
        legs.push(leg)
      }
      const arms: THREE.Group[] = []
      for (const side of [-1, 1]) {
        const arm = new THREE.Group()
        arm.position.set(side * 0.28, 0.6, -0.02)
        body.add(arm)
        mesh(arm, sphereGeometry, shirt, [0, 0, 0], [0.108, 0.108, 0.108])
        mesh(arm, sphereGeometry, shirt, [0, -0.13, -0.055], [0.11, 0.2, 0.11]).rotation.x = 0.25
        mesh(arm, sphereGeometry, palette.cream, [0, -0.25, -0.1], [0.1, 0.1, 0.04])
        mesh(arm, sphereGeometry, skin, [0, -0.28, -0.22], [0.085, 0.085, 0.23]).rotation.x = -0.12
        mesh(arm, sphereGeometry, skin, [0, -0.25, -0.43], [0.09, 0.05, 0.095])
        mesh(arm, sphereGeometry, skin, [0, -0.255, -0.47], [0.075, 0.04, 0.06])
        mesh(arm, sphereGeometry, skin, [-side * 0.065, -0.235, -0.4], [0.03, 0.03, 0.05])
        arms.push(arm)
      }
      occupant.visible = false
      const ringMaterial = new THREE.MeshStandardMaterial({ color: palette.idle, emissive: palette.idle, emissiveIntensity: 0.18, roughness: 0.8 })
      materials.add(ringMaterial)
      const ring = new THREE.Mesh(ringGeometry, ringMaterial)
      ring.rotation.x = -Math.PI / 2
      ring.position.set(0, 0.08, 1)
      ring.visible = false
      group.add(ring)
      const selection = box(group, palette.green, 0, 0.055, 0.25, 2.68, 0.015, 2.6)
      const selectionMaterial = new THREE.MeshBasicMaterial({ color: palette.green, transparent: true, opacity: 0.15, depthWrite: false })
      materials.add(selectionMaterial)
      selection.material = selectionMaterial
      selection.visible = false
      const seat: Workstation = {
        group, occupant, body, arms, legs, shirt, skin, hair, hairStyles, glasses, hood, restMouth, lookKey: '', screen: screenMaterial, activity, ring, selection,
        head, eyes, cup, steam, steamUntil: 0, idleOffset: (row * 3 + column) * 10 + row * 0.8, idleActivity: null, away: null,
        eyebrows, mouth, taskId: null, reactionStartedAt: null, emotionActivity: null,
        anchor: new THREE.Vector3(group.position.x, 2.5, group.position.z + 0.9), agentId: null, status: 'idle',
      }
      seats.push(seat)
    }
  }
  console.assert(seats.length === seatCount, 'The office must contain exactly the requested workstations')

  interface Figure {
    root: THREE.Group
    body: THREE.Group
    head: THREE.Group
    arms: THREE.Group[]
    legs: THREE.Group[]
    owned: THREE.Material[]
  }
  interface Departure extends Figure {
    route: THREE.Vector3[]
    waypoint: number
    elapsed: number
  }
  type Destination = 'coffee' | 'water' | 'shelf' | 'sofa'
  interface Walker extends Figure {
    seat: Workstation
    dest: Destination
    slot: number
    /** Seconds spent seated on the sofa. */
    rest: number
    phase: 'out' | 'act' | 'back' | 'sit'
    clock: number
    phaseStart: number
    targets: THREE.Vector3[]
    visited: THREE.Vector3[]
    prop: THREE.Group
    startedTask: string | null
    hurry: boolean
  }
  const departures = new Set<Departure>()
  const walkers = new Map<Workstation, Walker>()
  const taken = new Map<string, Workstation>()
  const nextWalk = new Map<Workstation, number>()
  const direction = new THREE.Vector3()
  let movementClock = 0
  let nextStart = 0

  // Where characters stand: at the pantry the right hand lines up with the machine and the dispenser tap.
  const LANE_X = -8.0
  const BOOK_TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.8)
  // Right hand holding a mug: forearm bent up toward the chest, mug resting in the palm with the handle outward.
  const HAND_MUG = new THREE.Vector3(0, -0.16, -0.47)
  const CARRY_ARM = 0.4
  const CARRY_ARM_Z = -0.25
  const BREW_ARM = -0.3
  const BREW_ARM_Z = 0
  // Raising the mug to the lips while seated: forearm up and in, mug tipped toward the face.
  const SIP_ARM = 1.45
  const SIP_ARM_Z = -0.3
  const SIP_ARM_Y = 0.6
  const SIP_TILT = 0.6
  const SIP_SECONDS = 7
  const PANTRY_STOPS = { coffee: new THREE.Vector3(LANE_X, 0, -6.22), water: new THREE.Vector3(LANE_X, 0, -5.34) }
  const EAST_X = 4
  const SHELF_SPOTS = [new THREE.Vector3(5.6, 0, -4.7), new THREE.Vector3(6.9, 0, -4.7)]
  const SOFA_Z = [1.8, 3.3]
  const SOFA_FRONT_X = 6.85
  const SOFA_SEAT_X = 7.55
  const SOFA_DROP = 0.14
  const SOFA = { turn: 0.5, sit: 0.9, stand: 0.9 }
  const WALK_SPEED = 2.1
  const STAND_UP_SECONDS = 0.45
  const MAX_WALKERS = 3
  const BREW_SECONDS = { coffee: 6, water: 4 }
  const SHELF_SECONDS = 8.4
  const CAPACITY: Record<Destination, number> = { coffee: 1, water: 1, shelf: 2, sofa: 2 }
  const AWAY_ACTIVITY = { coffee: 'pantry', water: 'pantry', shelf: 'books', sofa: 'sofa' } as const
  const DESTINATIONS: Destination[] = ['coffee', 'water', 'shelf', 'shelf', 'sofa', 'sofa']

  function turnToward(from: number, to: number, delta: number): number {
    const difference = ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI
    return from + difference * (1 - Math.exp(-12 * delta))
  }

  // `stand` runs from 0 (seated) to 1 (upright); `stride` is the walking swing.
  function pose(figure: Figure, stand: number, stride: number): void {
    figure.body.position.y = 0.76 + stand * 0.08 + Math.abs(stride) * 0.035
    figure.legs.forEach((leg, index) => {
      leg.rotation.x = (1 - stand) * Math.PI / 2 + stride * (index ? -0.48 : 0.48)
      leg.children[1]!.rotation.x = -(1 - stand) * Math.PI / 2
    })
    figure.arms.forEach((arm, index) => {
      arm.rotation.x = stand * -0.65 + stride * (index ? 0.35 : -0.35)
    })
  }

  /** A standing copy of the seated character; the seat's own model stays put or is hidden while the copy moves. */
  function cloneFigure(seat: Workstation, name: string): Figure {
    updateWorkstationAnimation(seat, 0, true)
    const root = seat.occupant.clone(true)
    root.visible = true
    root.name = name
    root.position.copy(seat.group.position)
    const body = root.children[0] as THREE.Group
    root.position.z += body.position.z
    body.position.z = 0
    const arms = seat.arms.map((arm) => body.children[seat.body.children.indexOf(arm)] as THREE.Group)
    const legs = seat.legs.map((leg) => body.children[seat.body.children.indexOf(leg)] as THREE.Group)
    // The desk can be reused while this character retains its original look.
    const owned = new Map<THREE.Material, THREE.Material>([seat.shirt, seat.skin, seat.hair].map((entry) => [entry, entry.clone()]))
    root.traverse((object) => {
      if (object instanceof THREE.Mesh && owned.has(object.material)) object.material = owned.get(object.material)!
    })
    body.scale.setScalar(1)
    body.rotation.set(0, 0, 0)
    return { root, body, head: body.children[seat.body.children.indexOf(seat.head)] as THREE.Group, arms, legs, owned: [...owned.values()] }
  }

  function depart(seat: Workstation): void {
    const figure = cloneFigure(seat, 'departing-agent')
    const x = seat.group.position.x
    const z = seat.group.position.z
    departures.add({
      ...figure, waypoint: 0, elapsed: 0,
      route: [
        new THREE.Vector3(x - 0.95, 0, z + 0.93),
        new THREE.Vector3(x - 0.95, 0, z + 1.98),
        new THREE.Vector3(-7.45, 0, z + 1.98),
        new THREE.Vector3(-7.45, 0, 4.55),
        new THREE.Vector3(-9.7, 0, 4.55),
      ],
    })
    room.add(figure.root)
  }

  function finishDeparture(departure: Departure): void {
    room.remove(departure.root)
    departure.owned.forEach((entry) => entry.dispose())
    departures.delete(departure)
  }

  function walkTo(seat: Workstation, dest: Destination): boolean {
    if (!seat.agentId || seat.away || seat.status === 'running' || walkers.size >= MAX_WALKERS) return false
    const slot = [...Array(CAPACITY[dest]).keys()].find((index) => !taken.has(`${dest}:${index}`))
    if (slot === undefined) return false
    const figure = cloneFigure(seat, 'walking-agent')
    let prop: THREE.Group
    if (dest === 'shelf') {
      prop = new THREE.Group()
      box(prop, '#c38e72', 0, 0, 0, 0.17, 0.05, 0.23)
      box(prop, palette.cream, 0.01, 0, 0, 0.16, 0.036, 0.22)
      prop.position.set(0, -0.26, -0.5)
      prop.visible = false
    } else {
      // The character picks up its own mug from the desk: filled at the pantry, or already hot coffee for the sofa.
      prop = seat.cup.clone()
      prop.position.copy(HAND_MUG)
      prop.rotation.set(0, 0, 0)
      prop.scale.setScalar(0.72)
      const liquid = prop.children[1] as THREE.Mesh
      liquid.visible = dest === 'sofa'
      if (dest === 'sofa') liquid.material = coffeeMaterial
      else if (dest === 'water') liquid.material = material('#bfe0ec')
      seat.cup.visible = false
    }
    prop.name = 'carried-prop'
    figure.arms[1]!.add(prop)
    taken.set(`${dest}:${slot}`, seat)
    const x = seat.group.position.x
    const z = seat.group.position.z
    const aisle = z + 1.98
    const targets = [new THREE.Vector3(x - 0.95, 0, z + 0.93), new THREE.Vector3(x - 0.95, 0, aisle)]
    if (dest === 'coffee' || dest === 'water') targets.push(new THREE.Vector3(LANE_X, 0, aisle), PANTRY_STOPS[dest].clone())
    else {
      targets.push(new THREE.Vector3(EAST_X, 0, aisle))
      if (dest === 'shelf') targets.push(new THREE.Vector3(EAST_X, 0, SHELF_SPOTS[slot]!.z), SHELF_SPOTS[slot]!.clone())
      else targets.push(new THREE.Vector3(EAST_X, 0, 1), new THREE.Vector3(6.55, 0, 1), new THREE.Vector3(SOFA_FRONT_X, 0, SOFA_Z[slot]!))
    }
    walkers.set(seat, {
      ...figure, seat, dest, slot, rest: 10 + Math.random() * 6, phase: 'out', clock: 0, phaseStart: 0, prop,
      startedTask: seat.taskId, hurry: false, visited: [new THREE.Vector3(x, 0, z + 0.93)], targets,
    })
    seat.occupant.visible = false
    seat.away = AWAY_ACTIVITY[dest]
    room.add(figure.root)
    return true
  }

  function releaseSlots(seat: Workstation): void {
    for (const [key, holder] of taken) if (holder === seat) taken.delete(key)
  }

  function endWalk(walker: Walker): void {
    const { seat } = walker
    room.remove(walker.root)
    walker.owned.forEach((entry) => entry.dispose())
    walkers.delete(seat)
    releaseSlots(seat)
    seat.away = null
    seat.cup.visible = true
    seat.occupant.visible = Boolean(seat.agentId)
    seat.anchor.set(seat.group.position.x, 2.5, seat.group.position.z + 0.9)
    nextWalk.set(seat, movementClock + 45 + Math.random() * 45)
  }

  // Up to three characters are out at once; the pantry stations take one, the shelf and the sofa two each.
  function scheduleWalks(reducedMotion: boolean): void {
    if (reducedMotion || walkers.size >= MAX_WALKERS || movementClock < nextStart) return
    for (const seat of seats) {
      if (!seat.agentId || seat.away || seat.status === 'running' || seat.emotionActivity || seat.idleActivity) continue
      const due = nextWalk.get(seat)
      if (due === undefined) nextWalk.set(seat, movementClock + 8 + Math.random() * 22)
      else if (due <= movementClock) {
        const choices = [...DESTINATIONS].sort(() => Math.random() - 0.5)
        if (choices.some((choice) => walkTo(seat, choice))) {
          nextStart = movementClock + 5
          return
        }
      }
    }
  }

  function actLength(walker: Walker): number {
    if (walker.dest === 'shelf') return SHELF_SECONDS
    if (walker.dest === 'sofa') return SOFA.turn + SOFA.sit + walker.rest + SOFA.stand
    return BREW_SECONDS[walker.dest]
  }

  // How far sitting has progressed (0 upright, 1 seated) at a moment of the sofa timeline.
  function sofaSeated(walker: Walker, time: number): number {
    const sitting = smoothstep((time - SOFA.turn) / SOFA.sit, 0, 1)
    const standing = smoothstep((time - SOFA.turn - SOFA.sit - walker.rest) / SOFA.stand, 0, 1)
    return sitting * (1 - standing)
  }

  function startBack(walker: Walker): void {
    walker.phase = 'back'
    walker.targets = [...walker.visited].reverse()
    walker.phaseStart = walker.clock
    if (walker.dest === 'shelf') walker.prop.visible = false
    releaseSlots(walker.seat)
  }

  // Work arrived mid-activity: skip to the end of it, standing up from the sofa from wherever the sit-down had reached.
  function cutAct(walker: Walker): void {
    const time = walker.clock - walker.phaseStart
    const standAt = SOFA.turn + SOFA.sit + walker.rest
    if (walker.dest === 'sofa' && time < standAt) {
      const seated = sofaSeated(walker, time)
      const progress = 0.5 - Math.sin(Math.asin(1 - 2 * (1 - seated)) / 3)
      walker.phaseStart = walker.clock - (standAt + SOFA.stand * progress)
    } else walker.phaseStart = walker.clock - actLength(walker)
  }

  const liquidOf = (walker: Walker): THREE.Mesh => walker.prop.children[1] as THREE.Mesh

  // Puts the carried mug back on the desk with whatever it was filled with.
  function setDownMug(walker: Walker): void {
    const top = walker.seat.cup.children[1] as THREE.Mesh
    const liquid = liquidOf(walker)
    top.material = liquid.material
    top.visible = liquid.visible
    // A freshly poured coffee keeps steaming on the desk for a while.
    if (liquid.visible && liquid.material === coffeeMaterial) walker.seat.steamUntil = movementClock + STEAM_SECONDS
    walker.seat.cup.visible = true
    walker.prop.visible = false
  }

  function updateWalkers(delta: number, reducedMotion: boolean): void {
    coffeeStream.visible = false
    waterStream.visible = false
    ledMaterial.emissive.set('#43c463')
    for (const walker of [...walkers.values()]) {
      const { seat } = walker
      if (reducedMotion || !seat.agentId) {
        endWalk(walker)
        continue
      }
      walker.clock += delta
      // New work or a new outcome sends the character straight back, hurrying along the same path.
      if (!walker.hurry && (seat.status === 'running' || seat.taskId !== walker.startedTask)) {
        walker.hurry = true
        if (walker.phase === 'out') startBack(walker)
        else if (walker.phase === 'act') cutAct(walker)
      }
      let stand = 1
      let stride = 0
      let lift = 0
      let rootX: number | undefined
      let armRight: number | undefined
      let armLeft: number | undefined
      let headX = 0
      let headY = 0
      let armRightZ = 0
      let armRightY = 0
      if (walker.phase === 'out' || walker.phase === 'back') {
        const next = walker.targets[0]
        if (next) {
          direction.subVectors(next, walker.root.position)
          if (direction.length() > 0.001) walker.body.rotation.y = turnToward(walker.body.rotation.y, Math.atan2(-direction.x, -direction.z), delta)
        }
        if (walker.phase === 'out' && walker.clock < STAND_UP_SECONDS) stand = smoothstep(walker.clock / STAND_UP_SECONDS, 0, 1)
        else {
          stride = Math.sin(walker.clock * (walker.hurry ? 12 : 8))
          let remaining = delta * WALK_SPEED * (walker.hurry ? 1.8 : 1)
          while (remaining > 0 && walker.targets.length) {
            const target = walker.targets[0]!
            direction.subVectors(target, walker.root.position)
            const distance = direction.length()
            if (distance <= remaining) {
              walker.root.position.copy(target)
              if (walker.phase === 'out') walker.visited.push(target.clone())
              walker.targets.shift()
              remaining -= distance
            } else {
              walker.root.position.addScaledVector(direction, remaining / distance)
              remaining = 0
            }
          }
          if (!walker.targets.length) {
            walker.phase = walker.phase === 'out' ? 'act' : 'sit'
            walker.phaseStart = walker.clock
          }
        }
      }
      let mugTilt = 0
      const time = walker.clock - walker.phaseStart
      if (walker.phase === 'act') {
        if (walker.dest === 'coffee' || walker.dest === 'water') {
          walker.body.rotation.y = turnToward(walker.body.rotation.y, Math.PI / 2, delta)
          const pouring = time > 1 && time < BREW_SECONDS[walker.dest] - 1
          liquidOf(walker).visible = time > 1.2
          if (walker.dest === 'coffee') {
            coffeeStream.visible = pouring
            if (pouring) ledMaterial.emissive.set('#e8a24a')
          } else waterStream.visible = pouring
          armRight = BREW_ARM + Math.sin(time * 3) * 0.03
          armRightZ = BREW_ARM_Z
          armLeft = -0.3
        } else if (walker.dest === 'shelf') {
          // Face the books, reach out, pick one, read it with a bowed head, then put it back.
          walker.body.rotation.y = turnToward(walker.body.rotation.y, 0, delta)
          const u = time - 0.4
          armRight = -0.65 + 0.8 * smoothstep(u, 0, 1) + 0.75 * smoothstep(u, 1, 1.6) - 0.75 * smoothstep(u, 6.6, 7.4) - 0.8 * smoothstep(u, 7.4, 8)
          if (u > 1.6 && u < 6.6) armRight += Math.sin(u * 1.5) * 0.03
          armLeft = -0.65 + 1.15 * smoothstep(u, 1.6, 2.2) - 1.15 * smoothstep(u, 6.4, 7)
          headX = 0.3 * smoothstep(u, 1.6, 2.2) - 0.3 * smoothstep(u, 6.4, 7)
          walker.prop.visible = u > 1.3 && u < 7.1
        } else {
          // Turn around, back up to the cushion and sit down; later stand up the same way. Seated, sip the coffee now and then.
          walker.body.rotation.y = turnToward(walker.body.rotation.y, Math.PI / 2, delta)
          const seated = sofaSeated(walker, time)
          stand = 1 - seated
          rootX = SOFA_FRONT_X + (SOFA_SEAT_X - SOFA_FRONT_X) * seated
          lift = -SOFA_DROP * seated
          armLeft = -0.5 - 0.15 * stand
          const cycle = Math.max(0, time - SOFA.turn - SOFA.sit) % SIP_SECONDS
          const sip = seated * smoothstep(cycle, 0.5, 1.5) * (1 - smoothstep(cycle, 3, 4))
          armRight = CARRY_ARM + (SIP_ARM - CARRY_ARM) * sip
          armRightZ = CARRY_ARM_Z + (SIP_ARM_Z - CARRY_ARM_Z) * sip
          armRightY = SIP_ARM_Y * sip
          mugTilt = SIP_TILT * sip
          headX = -0.14 * sip
          headY = Math.sin(time * 0.7 + walker.slot * 2) * 0.3 * seated * (1 - sip)
        }
        if (time >= actLength(walker)) startBack(walker)
      }
      const carrying = walker.dest !== 'shelf' && walker.prop.visible
      if (carrying && walker.phase !== 'act') {
        armRight = CARRY_ARM
        armRightZ = CARRY_ARM_Z
      }
      if (walker.phase === 'sit') {
        // Face the desk, then lower onto the chair; a carried mug is set down on the desk first.
        walker.body.rotation.y = turnToward(walker.body.rotation.y, 0, delta)
        stand = 1 - smoothstep(time, 0.3, 0.9)
        if (carrying && time >= 0.35) setDownMug(walker)
        if (time >= 0.9) {
          endWalk(walker)
          continue
        }
      }
      pose(walker, stand, stride)
      if (armRight !== undefined) walker.arms[1]!.rotation.x = armRight
      walker.arms[1]!.rotation.z = armRightZ
      walker.arms[1]!.rotation.y = armRightY
      if (armLeft !== undefined) walker.arms[0]!.rotation.x = armLeft
      walker.head.rotation.set(headX, headY, 0)
      walker.root.position.y = lift
      if (rootX !== undefined) walker.root.position.x = rootX
      walker.prop.quaternion.copy(walker.arms[1]!.quaternion).invert()
      if (walker.dest === 'shelf') walker.prop.quaternion.multiply(BOOK_TILT)
      else if (mugTilt) walker.prop.quaternion.multiply(tilt.setFromAxisAngle(AXIS_X, mugTilt))
      const steamNode = walker.prop.getObjectByName('steam')
      if (steamNode) {
        const liquid = liquidOf(walker)
        animateSteam(steamNode, movementClock, walker.prop.visible && liquid.visible && liquid.material === coffeeMaterial)
      }
      seat.anchor.set(walker.root.position.x, 2.5, walker.root.position.z)
    }
  }

  return {
    seats,
    bounds: { minZ: -7.5, maxZ: 7.5 + extra },
    setAgent(seat, agent): void {
      if (seat.away && seat.agentId !== (agent?.id ?? null)) endWalk(walkers.get(seat)!)
      if (!agent && seat.agentId) depart(seat)
      if (seat.agentId !== (agent?.id ?? null)) {
        updateWorkstationStatus(seat, 'idle', false, null)
        updateWorkstationAnimation(seat, 0, true)
      }
      seat.agentId = agent?.id ?? null
      seat.occupant.visible = Boolean(agent) && !seat.away
      seat.ring.visible = Boolean(agent)
      seat.shirt.color.set(agent?.color ?? '#a38fba')
      if (agent) applyAppearance(seat, agent)
      seat.group.userData.agentId = agent?.id
    },
    updateMovement(delta, reducedMotion): boolean {
      movementClock += delta
      scheduleWalks(reducedMotion)
      updateWalkers(delta, reducedMotion)
      for (const seat of seats) {
        const top = seat.cup.children[1] as THREE.Mesh
        const hot = !reducedMotion && Boolean(seat.agentId) && seat.cup.visible && top.visible && top.material === coffeeMaterial &&
          (seat.steamUntil > movementClock || seat.idleActivity === 'tea')
        animateSteam(seat.steam, movementClock, hot)
      }
      let doorOpen = false
      for (const departure of departures) {
        if (reducedMotion) {
          finishDeparture(departure)
          continue
        }
        departure.elapsed += delta
        const stand = Math.min(1, departure.elapsed / 0.3)
        const walking = stand === 1
        pose(departure, stand, walking ? Math.sin((departure.elapsed - 0.3) * 11) : 0)
        if (walking) {
          let remaining = delta * 3.2
          while (remaining > 0 && departure.waypoint < departure.route.length) {
            const target = departure.route[departure.waypoint]!
            direction.subVectors(target, departure.root.position)
            const distance = direction.length()
            if (distance > 0.001) departure.body.rotation.y = Math.atan2(-direction.x, -direction.z)
            if (distance <= remaining) {
              departure.root.position.copy(target)
              departure.waypoint++
              remaining -= distance
            } else {
              departure.root.position.addScaledVector(direction, remaining / distance)
              remaining = 0
            }
          }
        }
        if (departure.waypoint === departure.route.length) finishDeparture(departure)
        else if (departure.waypoint >= departure.route.length - 1) doorOpen = true
      }
      const targetAngle = doorOpen ? -Math.PI / 2 : 0
      door.rotation.y = reducedMotion ? 0 : THREE.MathUtils.damp(door.rotation.y, targetAngle, 12, delta)
      if (Math.abs(door.rotation.y - targetAngle) < 0.001) door.rotation.y = targetAngle
      return departures.size > 0 || walkers.size > 0 || door.rotation.y !== targetAngle
    },
    walkTo,
    dispose(): void {
      for (const walker of [...walkers.values()]) endWalk(walker)
      for (const departure of departures) finishDeparture(departure)
      geometries.forEach((geometry) => geometry.dispose())
      materials.forEach((entry) => entry.dispose())
      scene.remove(room)
    },
  }
}

export function updateWorkstationStatus(seat: Workstation, status: Workstation['status'], selected: boolean, taskId: string | null): void {
  if (seat.status !== status || seat.taskId !== taskId) seat.reactionStartedAt = null
  seat.taskId = taskId
  seat.status = status
  seat.selection.visible = selected
  seat.ring.material.color.set(palette[status])
  seat.ring.material.emissive.set(palette[status])
  seat.screen.color.set(seat.agentId ? '#a8c6b6' : '#c7d4cb')
  seat.screen.emissiveIntensity = status === 'running' ? 0.35 : 0.08
  seat.activity.forEach((line) => { line.visible = Boolean(seat.agentId) })
}
