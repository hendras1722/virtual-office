<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createOffice, updateWorkstationAnimation, updateWorkstationStatus } from './officeScene'
import { characterKey } from './character'
import type { ComponentPublicInstance } from 'vue'
import type { Agent, Task } from './types'
import type { OfficeModel, Workstation } from './officeScene'

const props = defineProps<{ agents: Agent[]; tasks: Task[]; selectedId: string | null; seats: number }>()
const emit = defineEmits<{ select: [id: string] }>()
const host = useTemplateRef<HTMLDivElement>('host')
const whip = useTemplateRef<SVGSVGElement>('whip')
const whipVisible = shallowRef(false)
let whipAnimations: Animation[] = []
const failure = shallowRef('')
const labels = new Map<string, HTMLElement>()
const occupied = new Map<string, Workstation>()
const statusText = { idle: 'Siap bekerja', running: 'Sedang bekerja', completed: 'Bahagia, tugas selesai', failed: 'Kecewa, tugas gagal' }
const statuses = computed(() => {
  const latest = new Map<string, Task>()
  for (const task of props.tasks) {
    const previous = latest.get(task.agentId)
    if (!previous || (task.status === 'running' && previous.status !== 'running') ||
      (task.status === previous.status && task.createdAt > previous.createdAt) ||
      (task.status !== 'running' && previous.status !== 'running' && task.createdAt > previous.createdAt)) {
      latest.set(task.agentId, task)
    }
  }
  return latest
})
const visibleAgents = computed(() => props.agents.slice(0, props.seats).map((agent) => ({
  ...agent, status: statuses.value.get(agent.id)?.status ?? 'idle' as const,
  taskId: statuses.value.get(agent.id)?.id ?? null,
  action: statuses.value.get(agent.id)?.status === 'running'
    ? statuses.value.get(agent.id)?.permission?.title || statuses.value.get(agent.id)?.activity || 'Sedang bekerja'
    : '',
  needsPermission: statuses.value.get(agent.id)?.status === 'running' && !!statuses.value.get(agent.id)?.permission,
})))
const counts = computed(() => {
  const waiting = visibleAgents.value.filter((agent) => agent.needsPermission).length
  const working = visibleAgents.value.filter((agent) => agent.status === 'running').length - waiting
  return { working, waiting, idle: visibleAgents.value.length - working - waiting }
})
const zones = shallowRef<OfficeModel['zones']>([])
const zoneLabels: HTMLElement[] = []

let renderer: THREE.WebGLRenderer | undefined
let scene: THREE.Scene | undefined
let camera: THREE.OrthographicCamera | undefined
let controls: OrbitControls | undefined
let office: OfficeModel | undefined
let observer: ResizeObserver | undefined
let motion: MediaQueryList | undefined
let frameId = 0
const FRAME_INTERVAL = 1000 / 30
let lastFrameTime = 0
let lastAnimationTime = 0
let animating = false
let shadowsMoving = false
let disposed = false
let width = 1
let height = 1
const projection = new THREE.Vector3()
const pointer = new THREE.Vector2()
const down = new THREE.Vector2()
const raycaster = new THREE.Raycaster()
let pointerId: number | null = null
let pointerMoved = false

function bindLabel(id: string, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLElement) labels.set(id, element)
  else labels.delete(id)
}

function bindZone(index: number, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLElement) zoneLabels[index] = element
}

function placeLabel(label: HTMLElement, anchor: THREE.Vector3, view: THREE.Camera): void {
  projection.copy(anchor).project(view)
  const visible = projection.z > -1 && projection.z < 1 && Math.abs(projection.x) < 1.12 && Math.abs(projection.y) < 1.12
  label.style.visibility = visible ? 'visible' : 'hidden'
  label.style.transform = `translate(${(projection.x * 0.5 + 0.5) * width}px, ${(-projection.y * 0.5 + 0.5) * height}px) translate(-50%, -100%)`
}

function scheduleRender(): void {
  if (!disposed && !document.hidden && !frameId && !failure.value) frameId = requestAnimationFrame(render)
}

function render(time: number): void {
  frameId = 0
  if (!renderer || !scene || !camera || !controls || disposed || document.hidden || failure.value) return
  const elapsed = time - lastFrameTime
  if (lastFrameTime && elapsed < FRAME_INTERVAL) {
    scheduleRender()
    return
  }
  const delta = lastAnimationTime ? Math.min((time - lastAnimationTime) / 1000, 0.05) : 0
  lastFrameTime = lastFrameTime ? time - elapsed % FRAME_INTERVAL : time
  lastAnimationTime = time
  const cameraMoving = controls.update()
  clampTarget()
  const reduced = motion?.matches ?? false
  const shadowsWereMoving = shadowsMoving
  shadowsMoving = office?.updateMovement(delta, reduced) ?? false
  animating = shadowsMoving
  for (const [id, seat] of occupied) {
    if (updateWorkstationAnimation(seat, time, reduced)) shadowsMoving = true
    if (!reduced) animating = true
    const label = labels.get(id)
    if (label) {
      const activity = label.lastElementChild
      const text = seat.emotionActivity === 'happy' ? 'Senang!' : seat.emotionActivity === 'disappointed' ? 'Kecewa' : seat.idleActivity === 'sleeping' ? 'Zzz · Tidur' : seat.idleActivity === 'tea' ? 'Minum teh' : seat.idleActivity === 'pantry' ? 'Ke pantry' : seat.idleActivity === 'books' ? 'Baca buku' : seat.idleActivity === 'sofa' ? 'Santai di sofa' : ''
      if (activity && activity.textContent !== text) activity.textContent = text
      placeLabel(label, seat.anchor, camera)
    }
  }
  for (const [index, zone] of zones.value.entries()) {
    const label = zoneLabels[index]
    if (label) placeLabel(label, zone.anchor, camera)
  }
  if (shadowsMoving || shadowsWereMoving) renderer.shadowMap.needsUpdate = true
  renderer.render(scene, camera)
  if (animating || cameraMoving) scheduleRender()
  else lastAnimationTime = 0
}

function syncAgents(): void {
  if (!office) return
  const agents = visibleAgents.value
  const ids = new Set(agents.map((agent) => agent.id))
  let changed = false
  for (const [id, seat] of occupied) {
    if (!ids.has(id)) {
      office.setAgent(seat, undefined)
      updateWorkstationStatus(seat, 'idle', false, null)
      occupied.delete(id)
      changed = true
    }
  }
  for (const agent of agents) {
    let seat = occupied.get(agent.id)
    if (!seat) {
      seat = office.seats.find((candidate) => !candidate.agentId)
      if (!seat) continue
      occupied.set(agent.id, seat)
    }
    const bindingChanged = seat.agentId !== agent.id || seat.shirt.color.getHex() !== Number.parseInt(agent.color.slice(1), 16) || seat.lookKey !== characterKey(agent)
    const selected = props.selectedId === agent.id
    if (bindingChanged) office.setAgent(seat, agent)
    if (bindingChanged || seat.status !== agent.status || seat.taskId !== agent.taskId || seat.selection.visible !== selected) {
      updateWorkstationStatus(seat, agent.status, selected, agent.taskId)
      changed = true
    }
  }
  if (changed) {
    if (renderer) renderer.shadowMap.needsUpdate = true
    scheduleRender()
  }
}

function fitCamera(): void {
  if (!host.value || !camera || !renderer) return
  width = Math.max(1, host.value.clientWidth)
  height = Math.max(1, host.value.clientHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  renderer.setSize(width, height)
  camera.updateMatrixWorld()
  let horizontal = 0
  let vertical = 0
  const minZ = (office?.bounds.minZ ?? -7.5) - 0.3
  const maxZ = (office?.bounds.maxZ ?? 7.5) + 0.3
  for (const x of [-9.5, 9.5]) for (const y of [-0.5, 3.7]) for (const z of [minZ, maxZ]) {
    projection.set(x, y, z).applyMatrix4(camera.matrixWorldInverse)
    horizontal = Math.max(horizontal, Math.abs(projection.x))
    vertical = Math.max(vertical, Math.abs(projection.y))
  }
  const aspect = width / height
  const halfHeight = Math.max(vertical, horizontal / aspect) * 1.08
  camera.left = -halfHeight * aspect
  camera.right = halfHeight * aspect
  camera.top = halfHeight
  camera.bottom = -halfHeight
  camera.updateProjectionMatrix()
  scheduleRender()
}

function resetCamera(): void {
  if (!camera || !controls) return
  const damping = controls.enableDamping
  controls.enableDamping = false
  controls.update()
  const centerZ = office ? (office.bounds.minZ + office.bounds.maxZ) / 2 : 0
  camera.position.set(11, 27, 30 + centerZ)
  controls.target.set(0, 0.7, centerZ)
  camera.zoom = 1
  camera.lookAt(controls.target)
  controls.update()
  controls.enableDamping = damping
  fitCamera()
}

let sun: THREE.DirectionalLight | undefined

// Pan only as far as the zoomed view still lies inside the room: none at fit zoom, the full room when zoomed in.
function clampTarget(): void {
  if (!camera || !controls || !office) return
  const slack = Math.max(0, 1 - 1 / camera.zoom)
  const { minZ, maxZ } = office.bounds
  const target = controls.target
  const x = THREE.MathUtils.clamp(target.x, -9 * slack, 9 * slack)
  const y = THREE.MathUtils.clamp(target.y, 0, 1.5)
  const z = THREE.MathUtils.clamp(target.z, (minZ + maxZ) / 2 - (maxZ - minZ) / 2 * slack, (minZ + maxZ) / 2 + (maxZ - minZ) / 2 * slack)
  if (x === target.x && y === target.y && z === target.z) return
  camera.position.x += x - target.x
  camera.position.y += y - target.y
  camera.position.z += z - target.z
  target.set(x, y, z)
}

function buildOffice(): void {
  if (!scene) return
  const previousDepth = office?.bounds.maxZ
  office?.dispose()
  occupied.clear()
  office = createOffice(scene, props.seats)
  zones.value = office.zones
  office.seats.forEach((seat) => updateWorkstationStatus(seat, 'idle', false, null))
  if (sun) {
    const extra = office.bounds.maxZ - 7.5
    const bound = 15 + extra / 2
    Object.assign(sun.shadow.camera, { left: -bound, right: bound, top: bound, bottom: -bound })
    sun.shadow.camera.updateProjectionMatrix()
    sun.position.set(-5, 16, 8 + extra / 2)
    sun.target.position.set(0, 0, extra / 2)
    const mapSize = extra > 0 ? 2048 : 1024
    if (sun.shadow.mapSize.x !== mapSize) {
      sun.shadow.mapSize.set(mapSize, mapSize)
      sun.shadow.map?.dispose()
      sun.shadow.map = null
    }
  }
  if (renderer) renderer.shadowMap.needsUpdate = true
  if (previousDepth !== undefined && previousDepth !== office.bounds.maxZ) resetCamera()
  else fitCamera()
  syncAgents()
}
watch(() => props.seats, buildOffice)

function zoomCamera(factor: number): void {
  if (!camera || !controls) return
  camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, controls.minZoom, controls.maxZoom)
  camera.updateProjectionMatrix()
  scheduleRender()
}

function cancelWhipAnimations(): void {
  for (const animation of whipAnimations) animation.cancel()
  whipAnimations = []
}

function hideWhip(): void {
  whipVisible.value = false
  if (whip.value) whip.value.style.visibility = 'hidden'
  cancelWhipAnimations()
}

function isWhipTarget(target: EventTarget | null): boolean {
  return target instanceof Element && (target === renderer?.domElement || !!target.closest('.agent-label'))
}

function moveWhip(event: PointerEvent): void {
  if (event.pointerType !== 'mouse' || !isWhipTarget(event.target) || !host.value || !whip.value) {
    hideWhip()
    return
  }
  const bounds = host.value.getBoundingClientRect()
  const x = event.clientX - bounds.left
  const y = event.clientY - bounds.top
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) {
    hideWhip()
    return
  }
  whip.value.style.transform = `translate(${x - 24}px, ${y - 96}px)`
  whip.value.style.visibility = 'visible'
  whipVisible.value = true
}

function crackWhip(event: MouseEvent): void {
  if (!whipVisible.value || !whip.value || event.button !== 0 || event.detail === 0 ||
    !isWhipTarget(event.target) || (event.target === renderer?.domElement && pointerMoved)) return
  cancelWhipAnimations()
  const swing = whip.value.querySelector('.whip-swing')
  const rope = whip.value.querySelector('.whip-rope')
  const snap = whip.value.querySelector('.whip-snap')
  if (!swing || !rope || !snap) return
  if (!motion?.matches) {
    whipAnimations.push(swing.animate([
      { transform: 'rotate(0deg)' },
      { transform: 'rotate(-38deg)', offset: 0.3 },
      { transform: 'rotate(48deg)', offset: 0.52 },
      { transform: 'rotate(-12deg)', offset: 0.76 },
      { transform: 'rotate(0deg)' },
    ], { duration: 460, easing: 'ease-in-out' }))
    whipAnimations.push(rope.animate([
      { transform: 'scale(1, 1)' },
      { transform: 'scale(0.65, 1.05) rotate(-18deg)', offset: 0.3 },
      { transform: 'scale(1.18, 0.75) rotate(22deg)', offset: 0.52 },
      { transform: 'scale(0.9, 1.08)', offset: 0.76 },
      { transform: 'scale(1, 1)' },
    ], { duration: 460, easing: 'ease-in-out' }))
  }
  whipAnimations.push(snap.animate([
    { opacity: 0 }, { opacity: 1, offset: 0.45 }, { opacity: 0 },
  ], { duration: motion?.matches ? 120 : 460 }))
}

function pointerDown(event: PointerEvent): void {
  if (pointerId !== null) {
    pointerMoved = true
    return
  }
  pointerId = event.pointerId
  down.set(event.clientX, event.clientY)
  pointerMoved = false
}

function pointerMove(event: PointerEvent): void {
  if (pointerId !== null && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) pointerMoved = true
}

function pointerUp(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return
  pointerId = null
  if (pointerMoved || event.button !== 0 || !renderer || !camera || !office) return
  const bounds = renderer.domElement.getBoundingClientRect()
  pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1)
  raycaster.setFromCamera(pointer, camera)
  const intersections = raycaster.intersectObjects(office.seats.map((seat) => seat.group), true)
  for (const intersection of intersections) {
    let object: THREE.Object3D | null = intersection.object
    let workstation: THREE.Object3D | undefined
    let visible = true
    while (object) {
      if (!object.visible) {
        visible = false
        break
      }
      if (object.userData.workstation) workstation = object
      object = object.parent
    }
    if (visible && workstation) {
      const id: unknown = workstation.userData.agentId
      if (typeof id === 'string') emit('select', id)
      return
    }
  }
}

function pointerCancel(): void {
  pointerId = null
  pointerMoved = false
}

function visibilityChanged(): void {
  if (document.hidden) {
    hideWhip()
    cancelAnimationFrame(frameId)
    frameId = 0
    lastFrameTime = lastAnimationTime = 0
  } else scheduleRender()
}

function motionChanged(): void {
  if (controls) controls.enableDamping = !motion?.matches
  if (motion?.matches) cancelWhipAnimations()
  scheduleRender()
}

function contextLost(event: Event): void {
  event.preventDefault()
  hideWhip()
  failure.value = 'Koneksi grafis terputus. Muat ulang halaman untuk membuka kantor kembali.'
  cancelAnimationFrame(frameId)
  frameId = 0
}

function disposeScene(): void {
  disposed = true
  hideWhip()
  cancelAnimationFrame(frameId)
  observer?.disconnect()
  document.removeEventListener('visibilitychange', visibilityChanged)
  motion?.removeEventListener('change', motionChanged)
  const canvas = renderer?.domElement
  canvas?.removeEventListener('pointerdown', pointerDown)
  canvas?.removeEventListener('pointermove', pointerMove)
  canvas?.removeEventListener('pointerup', pointerUp)
  canvas?.removeEventListener('pointercancel', pointerCancel)
  canvas?.removeEventListener('webglcontextlost', contextLost)
  controls?.removeEventListener('change', scheduleRender)
  controls?.dispose()
  office?.dispose()
  scene?.traverse((object) => {
    if (object instanceof THREE.DirectionalLight) object.shadow.dispose()
  })
  renderer?.dispose()
  canvas?.remove()
  occupied.clear()
  labels.clear()
}

watch([visibleAgents, () => props.selectedId], syncAgents, { deep: true })

onMounted(() => {
  if (!host.value) return
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.shadowMap.autoUpdate = false
    renderer.shadowMap.needsUpdate = true
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.setClearColor('#f2f0e9', 0)
    const canvas = renderer.domElement
    canvas.className = 'office-canvas'
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', 'Kantor virtual 3D. Geser untuk memutar dan gulir untuk memperbesar. Pilih agen melalui label namanya.')
    canvas.tabIndex = 0
    host.value.prepend(canvas)
    scene = new THREE.Scene()
    camera = new THREE.OrthographicCamera(-15, 15, 12, -12, 0.1, 150)
    scene.add(new THREE.HemisphereLight('#fff3ef', '#d9b9c4', 2.3))
    sun = new THREE.DirectionalLight('#ffe4c4', 4.3)
    sun.position.set(-5, 16, 8)
    sun.castShadow = true
    sun.shadow.mapSize.set(1024, 1024)
    sun.shadow.camera.left = -15
    sun.shadow.camera.right = 15
    sun.shadow.camera.top = 15
    sun.shadow.camera.bottom = -15
    sun.shadow.camera.near = 0.5
    sun.shadow.camera.far = 55
    sun.shadow.normalBias = 0.025
    sun.shadow.bias = -0.0002
    sun.shadow.radius = 4
    scene.add(sun, sun.target)
    const fill = new THREE.DirectionalLight('#e4dcf5', 1.1)
    fill.position.set(9, 8, -9)
    scene.add(fill)
    buildOffice()
    motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    controls = new OrbitControls(camera, canvas)
    controls.enableDamping = !motion.matches
    controls.dampingFactor = 0.15
    controls.enablePan = true
    controls.screenSpacePanning = false
    controls.zoomToCursor = true
    controls.minPolarAngle = Math.PI / 7
    controls.maxPolarAngle = Math.PI / 2.55
    controls.minAzimuthAngle = 0.05
    controls.maxAzimuthAngle = Math.PI / 2.15
    controls.minZoom = 0.65
    controls.maxZoom = 4
    controls.listenToKeyEvents(canvas)
    controls.addEventListener('change', scheduleRender)
    canvas.addEventListener('pointerdown', pointerDown)
    canvas.addEventListener('pointermove', pointerMove)
    canvas.addEventListener('pointerup', pointerUp)
    canvas.addEventListener('pointercancel', pointerCancel)
    canvas.addEventListener('webglcontextlost', contextLost)
    document.addEventListener('visibilitychange', visibilityChanged)
    motion.addEventListener('change', motionChanged)
    observer = new ResizeObserver(fitCamera)
    observer.observe(host.value)
    resetCamera()
    syncAgents()
  } catch (error) {
    console.error('Unable to initialize the 3D office:', error)
    failure.value = 'Kantor 3D tidak dapat ditampilkan. Aktifkan WebGL atau akselerasi grafis di browser, lalu muat ulang halaman.'
    disposeScene()
  }
})
onBeforeUnmount(disposeScene)
</script>

<template>
  <div
    ref="host"
    class="office-scene"
    :class="{ 'has-whip': whipVisible }"
    @pointermove="moveWhip"
    @pointerleave="hideWhip"
    @pointercancel="hideWhip"
    @click="crackWhip"
  >
    <template v-if="!failure">
      <svg ref="whip" class="whip-cursor" viewBox="0 0 180 160" width="135" height="120" fill="none" aria-hidden="true">
        <g class="whip-swing">
          <g class="whip-rope" stroke-linecap="round" stroke-linejoin="round">
            <path class="whip-outline" d="M46 99C8 43 74 4 119 25C164 47 118 92 91 61C64 30 141 18 151 61" stroke-width="6" />
            <path class="whip-leather" d="M46 99C8 43 74 4 119 25C164 47 118 92 91 61C64 30 141 18 151 61" stroke-width="3" />
            <path class="whip-snap" d="M139 47L130 39M154 43L156 30M164 52L177 47M164 65L175 72" stroke-width="3" stroke-linecap="round" />
          </g>
          <path class="whip-grip" d="M30 130L46 100" stroke-width="11" stroke-linecap="round" />
          <path class="whip-wrap" d="M29 122L37 126M33 114L41 118M37 106L45 110" stroke-width="2" stroke-linecap="round" />
          <path class="whip-leather" d="M26 133L32 137" stroke-width="5" stroke-linecap="round" />
        </g>
      </svg>
      <div class="agent-labels">
        <span v-for="(zone, index) in zones" :key="zone.label" :ref="(element) => bindZone(index, element)" class="zone-label" aria-hidden="true">{{ zone.label }}</span>
        <button
          v-for="agent in visibleAgents"
          :key="agent.id"
          :ref="(element) => bindLabel(agent.id, element)"
          type="button"
          class="agent-label"
          :class="[{ 'is-selected': selectedId === agent.id, 'needs-permission': agent.needsPermission }, `status-${agent.status}`]"
          :style="{ '--agent-color': agent.color }"
          :aria-label="`${agent.name}, ${agent.needsPermission ? 'Menunggu izin: ' : ''}${agent.action || statusText[agent.status]}. ${agent.needsPermission ? 'Lihat detail izin di bawah kantor' : 'Pilih agen'}`"
          :title="`${agent.name}${agent.action ? ` · ${agent.action}` : ''}`"
          :aria-pressed="selectedId === agent.id"
          @click="emit('select', agent.id)"
        >
          <span class="label-dot" aria-hidden="true">{{ agent.needsPermission ? '!' : agent.status === 'completed' ? '✓' : agent.status === 'failed' ? '!' : '' }}</span>
          <span class="label-name"><span v-if="agent.needsPermission" class="permission-caption">Minta izin</span>{{ agent.needsPermission ? agent.action : agent.name }}</span>
          <span v-if="agent.status === 'running' && !agent.needsPermission" class="typing-dots" aria-hidden="true">···</span>
          <span class="idle-action" aria-hidden="true"></span>
        </button>
      </div>
      <div v-if="visibleAgents.length" class="office-hud">
        <span class="hud-live"><i aria-hidden="true" />Live</span>
        <span>Bekerja <b>{{ counts.working }}</b></span>
        <span>Idle <b>{{ counts.idle }}</b></span>
        <span class="hud-waiting" :class="{ active: counts.waiting }">Tunggu izin <b>{{ counts.waiting }}</b></span>
      </div>
      <div class="camera-controls" role="group" aria-label="Kontrol kamera kantor">
        <button type="button" class="camera-button" aria-label="Perbesar kantor" title="Perbesar" @click="zoomCamera(1.2)">+</button>
        <button type="button" class="camera-button" aria-label="Perkecil kantor" title="Perkecil" @click="zoomCamera(1 / 1.2)">−</button>
        <span class="control-divider" aria-hidden="true"></span>
        <button type="button" class="camera-button reset-button" aria-label="Atur ulang kamera" title="Atur ulang kamera" @click="resetCamera">
          <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4.5 7A6 6 0 1 1 4 12M4.5 3v4h4" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      </div>
    </template>
    <div v-else class="webgl-error" role="alert">
      <span class="error-symbol" aria-hidden="true">◇</span>
      <strong>Tampilan 3D tidak tersedia</strong>
      <p>{{ failure }}</p>
      <p class="error-note">Data agen dan tugas tetap bisa diakses melalui panel kantor.</p>
    </div>
  </div>
</template>

<style scoped>
.office-scene { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; isolation: isolate; background: radial-gradient(ellipse at 50% 40%, #fff8f4 0%, #f8eaf0 62%, #efe0ec 100%); }
.office-scene :deep(.office-canvas) { display: block; width: 100%; height: 100%; touch-action: none; outline-offset: -4px; }
.office-scene :deep(.office-canvas:focus-visible) { outline: 2px solid var(--accent, #54745c); }
.office-scene.has-whip :deep(.office-canvas), .office-scene.has-whip .agent-label { cursor: none; }
.whip-cursor { position: absolute; top: 0; left: 0; z-index: 3; visibility: hidden; pointer-events: none; overflow: visible; filter: drop-shadow(0 2px 1px var(--border)); }
.whip-swing { transform-origin: 32px 128px; }
.whip-rope { transform-origin: 46px 99px; }
.whip-outline, .whip-grip { stroke: var(--text); }
.whip-leather, .whip-snap { stroke: var(--amber); }
.whip-wrap { stroke: var(--surface); }
.whip-snap { opacity: 0; }
.agent-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.zone-label { position: absolute; top: 0; left: 0; visibility: hidden; padding: 4px 11px; border: 1.5px solid #f3dde6; border-radius: 9px; background: #fffffff2; color: #4b3f5c; font-size: 11px; font-weight: 800; letter-spacing: .2px; white-space: nowrap; box-shadow: 0 3px 10px #7a4d6a1f; }
.agent-label { position: absolute; top: 0; left: 0; visibility: hidden; display: flex; align-items: center; gap: 6px; max-width: 160px; min-height: 26px; padding: 4px 11px 4px 5px; border: 1.5px solid #fff; border-radius: 999px; background: #fffffff5; color: #3d3550; font-family: inherit; font-weight: 700; font-size: 11px; line-height: 1.3; box-shadow: 0 4px 12px #6b4b6a26, 0 1px 2px #6b4b6a14; pointer-events: auto; cursor: pointer; white-space: nowrap; transition: box-shadow 150ms, border-color 150ms; }
.agent-label:hover, .agent-label.is-selected { z-index: 2; background: #fff; border-color: #c9b3ea; box-shadow: 0 0 0 3px #c9b3ea59, 0 5px 14px #6b4b6a2e; }
.agent-label:focus-visible, .camera-button:focus-visible { outline: 2px solid #8a6fc4; outline-offset: 3px; }
.label-name { overflow: hidden; text-overflow: ellipsis; }
.agent-label.needs-permission { max-width: 220px; padding: 6px 12px 6px 7px; white-space: normal; border: 2px solid #e6b54a; border-radius: 14px; background: linear-gradient(#fffbf1, #fff1d6); color: #4a3a1f; box-shadow: 0 0 0 3px #fff, 0 6px 16px #b7862b33; z-index: 1; cursor: pointer; }
.agent-label.needs-permission::after { content: ''; position: absolute; left: 50%; bottom: -7px; width: 10px; height: 10px; border: solid #e6b54a; border-width: 0 2px 2px 0; background: #fff1d6; transform: translateX(-50%) rotate(45deg); }
.agent-label.needs-permission .label-dot { width: 16px; height: 16px; background: #e6b54a; box-shadow: none; font-size: 10px; animation: none; }
.needs-permission .label-name { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.permission-caption { display: block; color: #b7862b; font-size: 9px; text-transform: uppercase; letter-spacing: .6px; }
.label-dot { flex: 0 0 auto; display: grid; place-items: center; width: 12px; height: 12px; border-radius: 50%; background: #b7b1c2; color: #fff; font-size: 8px; box-shadow: 0 0 0 2px #fff, 0 0 0 3px #b7b1c255; }
.status-running .label-dot { background: #3fb67a; box-shadow: 0 0 0 2px #fff, 0 0 0 3px #3fb67a66; animation: label-pulse 1.6s ease-in-out infinite; }
.status-completed .label-dot { background: #6fa4dc; }
.status-failed .label-dot { background: #e27b7b; }
@keyframes label-pulse { 50% { box-shadow: 0 0 0 2px #fff, 0 0 0 6px #3fb67a22; } }
.typing-dots { color: #3fb67a; font-size: 16px; line-height: 8px; letter-spacing: 1px; }
.idle-action { flex-shrink: 0; font-size: 10px; font-weight: 700; color: #8a6fc4; }.idle-action:empty { display: none; }
.office-hud { position: absolute; left: 16px; bottom: 18px; display: flex; align-items: center; gap: 12px; padding: 7px 14px; border: 1.5px solid #fff; border-radius: 999px; background: #fffffff2; color: #4a4257; font-size: 11px; font-weight: 600; white-space: nowrap; box-shadow: 0 4px 14px #6b4b6a1f; pointer-events: none; }
.office-hud b { font-weight: 800; color: #2f2840; }
.hud-live { display: flex; align-items: center; gap: 6px; font-weight: 800; }
.hud-live i { width: 8px; height: 8px; border-radius: 50%; background: #ef5a6f; box-shadow: 0 0 0 3px #ef5a6f2e; }
.hud-waiting.active { margin: -3px -8px -3px 0; padding: 3px 9px; border-radius: 999px; background: #fff1d6; color: #8a6520; }
.camera-controls { position: absolute; right: 24px; bottom: 20px; display: flex; align-items: center; gap: 2px; padding: 5px; border: 1.5px solid #fff; border-radius: 999px; background: #fffffff2; box-shadow: 0 4px 14px #6b4b6a1f; }
.camera-button { display: grid; place-items: center; width: 31px; height: 31px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: #6b5a7a; font: 400 22px/1 sans-serif; cursor: pointer; }
.camera-button:hover { background: #f6ecf3; color: #4b3f5c; }
.control-divider { width: 1px; height: 17px; margin: 0 3px; background: #eedfe8; }
.webgl-error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; padding: 35px; color: #596951; text-align: center; }
.error-symbol { font-size: 48px; color: #92a387; }
.webgl-error > strong { font-size: 18px; }
.webgl-error > p { max-width: 420px; margin: 0; font-size: 13px; line-height: 1.65; }
.webgl-error > .error-note { color: #8a9282; font-size: 11px; }
@media (max-width: 640px) {
  .camera-controls { right: 14px; bottom: 14px; }
  .office-hud { top: 10px; bottom: auto; left: 10px; gap: 9px; padding: 5px 11px; font-size: 10px; }
  .zone-label { padding: 3px 8px; font-size: 9px; }
  .agent-label { max-width: 110px; min-height: 24px; font-size: 9px; padding: 3px 7px 3px 4px; gap: 4px; }
  .agent-label.needs-permission { max-width: 145px; }
  .needs-permission:not(.is-selected):not(:focus-visible) { justify-content: center; min-width: 26px; }
  .needs-permission:not(.is-selected):not(:focus-visible) .label-name { display: none; }
  .agent-label:not(.is-selected):not(.needs-permission):not(:focus-visible) { opacity: 0; pointer-events: none; }
}
@media (prefers-reduced-motion: reduce) { .agent-label { transition: none; } .status-running .label-dot { animation: none; } }
</style>
