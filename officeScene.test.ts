import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { createOffice, updateWorkstationAnimation, updateWorkstationStatus } from './src/officeScene'
import { characterKey } from './src/character'
import type { Agent } from './src/types'

const agent: Agent = {
  id: 'animation-agent', name: 'Animation agent', role: 'Developer', provider: 'custom',
  model: 'test', color: '#8c9eff', createdAt: '2026-10-22T00:00:00Z', workspace: '', allowTools: false,
}

test('should keep animating after the character exits until the door closes', () => {
  const scene = new THREE.Scene()
  const office = createOffice(scene)
  try {
    const restingRotations = new Map<THREE.Object3D, number>()
    scene.traverse((object) => restingRotations.set(object, object.rotation.y))
    const seat = office.seats[0]!
    office.setAgent(seat, agent)
    office.setAgent(seat, undefined)
    let active = true
    let closesAfterExit = false
    for (let frame = 0; active && frame < 600; frame++) {
      active = office.updateMovement(1 / 30, false)
      const roomMoving = [...restingRotations].some(([object, rotation]) => object.rotation.y !== rotation)
      if (!scene.getObjectByName('departing-agent') && roomMoving && active) closesAfterExit = true
    }
    expect(closesAfterExit).toBe(true)
    expect(active).toBe(false)
    expect(scene.getObjectByName('departing-agent')).toBeUndefined()
    expect([...restingRotations].every(([object, rotation]) => object.rotation.y === rotation)).toBe(true)
  } finally {
    office.dispose()
  }
})

test('should finish a departure immediately when reduced motion is enabled', () => {
  const scene = new THREE.Scene()
  const office = createOffice(scene)
  try {
    office.setAgent(office.seats[0]!, agent)
    office.setAgent(office.seats[0]!, undefined)
    expect(scene.getObjectByName('departing-agent')).toBeDefined()
    expect(office.updateMovement(0, true)).toBe(false)
    expect(scene.getObjectByName('departing-agent')).toBeUndefined()
  } finally {
    office.dispose()
  }
})

test('should visibly sleep and lift a cup to the face in different parts of the idle cycle', () => {
  const scene = new THREE.Scene()
  const office = createOffice(scene)
  try {
    const seat = office.seats[0]!
    office.setAgent(seat, agent)
    const cupRest = seat.cup.position.clone()
    const eyeHeight = seat.eyes[0]!.scale.y
    updateWorkstationAnimation(seat, 2000, false)
    expect(seat.idleActivity).toBe('sleeping')
    expect(seat.head.rotation.x).toBeLessThan(-0.3)
    expect(seat.body.rotation.x).toBeGreaterThan(0.15)
    expect(seat.eyes[0]!.scale.y).toBeLessThan(eyeHeight / 2)
    expect(seat.cup.position.equals(cupRest)).toBe(true)
    updateWorkstationAnimation(seat, 12000, false)
    expect(seat.idleActivity).toBe('tea')
    expect(seat.arms[1]!.rotation.x).toBeGreaterThan(1)
    expect(seat.cup.position.y).toBeGreaterThan(cupRest.y + 0.3)
    const mouth = seat.head.localToWorld(new THREE.Vector3(0, 0.12, -0.249))
    expect(seat.cup.getWorldPosition(new THREE.Vector3()).distanceTo(mouth)).toBeLessThan(0.3)
    expect(seat.eyes[0]!.scale.y).toBe(eyeHeight)
  } finally {
    office.dispose()
  }
})

test.each(['working', 'reduced-motion', 'departure'])('should put the cup down and end idle activity on %s', (transition) => {
  const scene = new THREE.Scene()
  const office = createOffice(scene)
  try {
    const seat = office.seats[0]!
    office.setAgent(seat, agent)
    const cupRest = seat.cup.position.clone()
    updateWorkstationAnimation(seat, 12000, false)
    expect(seat.cup.position.equals(cupRest)).toBe(false)
    if (transition === 'departure') {
      office.setAgent(seat, undefined)
      expect(scene.getObjectByName('departing-agent')).toBeDefined()
    } else {
      if (transition === 'working') updateWorkstationStatus(seat, 'running', false, 'running-task')
      updateWorkstationAnimation(seat, 12000, transition === 'reduced-motion')
      expect(seat.arms[1]!.rotation.z).toBe(0)
    }
    expect(seat.idleActivity).toBeNull()
    expect(seat.cup.position.equals(cupRest)).toBe(true)
    expect(seat.cup.rotation.x).toBe(0)
    expect(seat.head.rotation.x).toBeCloseTo(0)
    if (transition === 'reduced-motion') {
      expect(seat.body.scale.y).toBe(1)
      expect(seat.arms.every((arm) => arm.rotation.x === 0)).toBe(true)
    }
  } finally {
    office.dispose()
  }
})

test.each(['failed', 'completed'] as const)('should show a distinct %s face and moving reaction without picking up the cup', (status) => {
  const office = createOffice(new THREE.Scene())
  try {
    const seat = office.seats[0]!
    office.setAgent(seat, agent)
    const cupRest = seat.cup.position.clone()
    updateWorkstationStatus(seat, status, false, 'outcome-task')
    updateWorkstationAnimation(seat, 0, false)
    expect(updateWorkstationAnimation(seat, 1000, false)).toBe(true)
    expect(seat.emotionActivity).toBe(status === 'completed' ? 'happy' : 'disappointed')
    expect(seat.idleActivity).toBeNull()
    expect(seat.cup.position.equals(cupRest)).toBe(true)
    expect(seat.mouth.visible).toBe(true)
    expect(seat.eyebrows.every((brow) => brow.visible)).toBe(true)
    const mouthCenter = seat.mouth.getWorldPosition(new THREE.Vector3())
    const mouthCurve = seat.mouth.localToWorld(new THREE.Vector3(0, 0.07, 0))
    if (status === 'completed') {
      expect(mouthCurve.y).toBeLessThan(mouthCenter.y)
      expect(seat.arms.every((arm) => arm.rotation.x > 1.5)).toBe(true)
      expect(seat.body.position.y).toBeGreaterThan(0.8)
    } else {
      expect(mouthCurve.y).toBeGreaterThan(mouthCenter.y)
      expect(seat.head.rotation.x).toBeLessThan(-0.3)
      expect(seat.eyebrows[0]!.rotation.z).toBeGreaterThan(0)
      expect(seat.arms[1]!.rotation.x).toBeGreaterThan(1)
    }
    const gesture = status === 'completed' ? seat.arms[0]!.rotation.x : seat.head.rotation.y
    updateWorkstationAnimation(seat, 1250, false)
    expect(status === 'completed' ? seat.arms[0]!.rotation.x : seat.head.rotation.y).not.toBe(gesture)
  } finally {
    office.dispose()
  }
})

test('should not replay reactions on selection or identical polls, but should react to another completed task', () => {
  const office = createOffice(new THREE.Scene())
  try {
    const seat = office.seats[0]!
    office.setAgent(seat, agent)
    updateWorkstationStatus(seat, 'completed', false, 'first-task')
    updateWorkstationAnimation(seat, 0, false)
    updateWorkstationAnimation(seat, 1000, false)
    updateWorkstationStatus(seat, 'completed', true, 'first-task')
    updateWorkstationAnimation(seat, 12000, false)
    expect(seat.emotionActivity).toBeNull()
    expect(seat.idleActivity).toBe('tea')
    expect(seat.mouth.visible).toBe(true)
    updateWorkstationStatus(seat, 'completed', true, 'second-task')
    updateWorkstationAnimation(seat, 13000, false)
    updateWorkstationAnimation(seat, 13500, false)
    expect(seat.emotionActivity).toBe('happy')
    expect(seat.idleActivity).toBeNull()
  } finally {
    office.dispose()
  }
})

test.each(['failed', 'completed'] as const)('should stop the %s gesture for reduced motion, new work and seat reuse', (status) => {
  const office = createOffice(new THREE.Scene())
  try {
    const seat = office.seats[0]!
    office.setAgent(seat, agent)
    const cupRest = seat.cup.position.clone()
    updateWorkstationStatus(seat, status, false, 'outcome-task')
    updateWorkstationAnimation(seat, 0, false)
    updateWorkstationAnimation(seat, 1000, false)
    expect(updateWorkstationAnimation(seat, 1100, true)).toBe(false)
    expect(seat.emotionActivity).toBeNull()
    expect(seat.body.position.y).toBe(0.76)
    expect(seat.body.rotation.y).toBeCloseTo(0)
    expect(seat.head.rotation.y).toBeCloseTo(0)
    expect(seat.arms.every((arm) => arm.rotation.x === 0 && arm.rotation.z === 0)).toBe(true)
    expect(seat.mouth.visible).toBe(true)
    updateWorkstationStatus(seat, 'running', false, 'new-work')
    updateWorkstationAnimation(seat, 1200, false)
    expect(seat.emotionActivity).toBeNull()
    expect(seat.mouth.visible).toBe(false)
    expect(seat.eyebrows.every((brow) => !brow.visible)).toBe(true)
    expect(seat.cup.position.equals(cupRest)).toBe(true)
    updateWorkstationStatus(seat, status, false, 'another-outcome')
    updateWorkstationAnimation(seat, 1300, false)
    updateWorkstationAnimation(seat, 2300, false)
    office.setAgent(seat, undefined)
    const departing = (seat.group.parent as THREE.Group).getObjectByName('departing-agent')!
    expect(departing.children[0]!.position.y).toBe(0.76)
    office.setAgent(seat, { ...agent, id: 'replacement-agent' })
    expect(seat.status).toBe('idle')
    expect(seat.mouth.visible).toBe(false)
    expect(seat.emotionActivity).toBeNull()
  } finally {
    office.dispose()
  }
})

test('should keep a departing character look when the seat is reused by another agent', () => {
  const scene = new THREE.Scene()
  const office = createOffice(scene)
  try {
    const seat = office.seats[0]!
    const looks = new Set<string>()
    for (let index = 0; index < 24; index++) {
      office.setAgent(seat, { ...agent, id: `look-${index}` })
      looks.add(`${seat.skin.color.getHexString()}${seat.hair.color.getHexString()}${seat.hairStyles.findIndex((group) => group.visible)}`)
    }
    expect(looks.size).toBeGreaterThan(8)
    office.setAgent(seat, { ...agent, id: 'look-leaving' })
    const look = [seat.skin.color.getHex(), seat.hair.color.getHex()]
    office.setAgent(seat, undefined)
    const departing = scene.getObjectByName('departing-agent')!
    for (let index = 24; seat.skin.color.getHex() === look[0] && seat.hair.color.getHex() === look[1]; index++) {
      office.setAgent(seat, { ...agent, id: `look-${index}` })
    }
    const colors: number[] = []
    departing.traverse((object) => {
      if (object instanceof THREE.Mesh && object.visible) colors.push(object.material.color.getHex())
    })
    expect(colors).toContain(look[0]!)
    expect(colors).toContain(look[1]!)
  } finally {
    office.dispose()
  }
})

test('should lift the mug and set it back on the desk without jumps', () => {
  const office = createOffice(new THREE.Scene())
  try {
    const seat = office.seats[0]!
    office.setAgent(seat, agent)
    const rest = seat.cup.position.clone()
    let previous = rest.clone()
    let highest = rest.y
    for (let time = 10000; time <= 19000; time += 50) {
      updateWorkstationAnimation(seat, time, false)
      expect(seat.cup.position.distanceTo(previous)).toBeLessThan(0.06)
      previous = seat.cup.position.clone()
      highest = Math.max(highest, previous.y)
    }
    expect(highest).toBeGreaterThan(rest.y + 0.3)
    expect(seat.cup.position.equals(rest)).toBe(true)
    expect(seat.cup.rotation.x).toBe(0)
    expect(seat.arms[1]!.rotation.x).toBeCloseTo(0)
  } finally {
    office.dispose()
  }
})

test.each([1, 4, 13, 24])('should build exactly %i desks that all fit inside the room', (count) => {
  const scene = new THREE.Scene()
  const office = createOffice(scene, count)
  try {
    expect(office.seats).toHaveLength(count)
    const positions = new Set(office.seats.map((seat) => `${seat.group.position.x},${seat.group.position.z}`))
    expect(positions.size).toBe(count)
    for (const seat of office.seats) {
      expect(seat.group.position.z).toBeGreaterThan(office.bounds.minZ)
      expect(seat.group.position.z + 1.6).toBeLessThan(office.bounds.maxZ)
    }
    expect(office.bounds.maxZ).toBeGreaterThanOrEqual(7.5)
    office.setAgent(office.seats[count - 1]!, agent)
    office.setAgent(office.seats[count - 1]!, undefined)
    let active = true
    for (let frame = 0; active && frame < 1200; frame++) active = office.updateMovement(1 / 30, false)
    expect(active).toBe(false)
  } finally {
    office.dispose()
  }
})

test('should show the character chosen for an agent and fall back to the id look when none is chosen', () => {
  const office = createOffice(new THREE.Scene())
  try {
    const seat = office.seats[0]!
    const chosen = { skin: 5, hairStyle: 3, hairColor: 7, glasses: true, hood: true }
    office.setAgent(seat, { ...agent, id: 'chosen-look', character: chosen })
    expect(seat.skin.color.getHexString()).toBe('6f452f')
    expect(seat.hair.color.getHexString()).toBe('b9b6ae')
    expect(seat.hairStyles.findIndex((group) => group.visible)).toBe(3)
    expect(seat.glasses.visible).toBe(true)
    expect(seat.hood.visible).toBe(true)
    const chosenKey = seat.lookKey
    office.setAgent(seat, { ...agent, id: 'chosen-look', character: { ...chosen, glasses: false } })
    expect(seat.lookKey).not.toBe(chosenKey)
    expect(seat.glasses.visible).toBe(false)
    office.setAgent(seat, { ...agent, id: 'chosen-look', character: null })
    expect(seat.lookKey).toBe(characterKey({ id: 'chosen-look' }))
  } finally {
    office.dispose()
  }
})

function steps(office: { updateMovement: (delta: number, reduced: boolean) => boolean }, seconds: number, each?: () => void): void {
  for (let frame = 0; frame < seconds * 30; frame++) {
    office.updateMovement(1 / 30, false)
    each?.()
  }
}

test('should send a calm idle character to the pantry and seat it again at its own desk', () => {
  const scene = new THREE.Scene()
  const office = createOffice(scene)
  try {
    const seat = office.seats[4]!
    office.setAgent(seat, agent)
    const anchor = seat.anchor.clone()
    expect(office.walkTo(seat, 'coffee')).toBe(true)
    expect(office.walkTo(office.seats[5]!, 'coffee')).toBe(false)
    expect(seat.away).toBe('pantry')
    expect(seat.occupant.visible).toBe(false)
    updateWorkstationAnimation(seat, 0, false)
    expect(seat.idleActivity).toBe('pantry')
    let nearest = Infinity
    let westmost = 0
    let frames = 0
    while (seat.away && frames++ < 3000) {
      office.updateMovement(1 / 30, false)
      const walker = scene.getObjectByName('walking-agent')
      if (!walker) continue
      nearest = Math.min(nearest, Math.hypot(walker.position.x + 7.95, walker.position.z + 6.22))
      westmost = Math.min(westmost, walker.position.x)
      expect(seat.anchor.x).toBeCloseTo(walker.position.x)
    }
    expect(seat.away).toBeNull()
    expect(nearest).toBeLessThan(0.05)
    expect(westmost).toBeGreaterThan(-8.3)
    expect(seat.occupant.visible).toBe(true)
    expect(scene.getObjectByName('walking-agent')).toBeUndefined()
    expect(seat.anchor.equals(anchor)).toBe(true)
  } finally {
    office.dispose()
  }
})

test('should hurry a character back to its desk when work arrives during the break', () => {
  const office = createOffice(new THREE.Scene())
  try {
    const seat = office.seats[4]!
    office.setAgent(seat, agent)
    office.walkTo(seat, 'coffee')
    steps(office, 3)
    expect(seat.away).toBe('pantry')
    updateWorkstationStatus(seat, 'running', false, 'urgent')
    steps(office, 5)
    expect(seat.away).toBeNull()
    expect(seat.occupant.visible).toBe(true)
  } finally {
    office.dispose()
  }
})

test('should end the break at once for reduced motion and when the agent leaves', () => {
  const scene = new THREE.Scene()
  const office = createOffice(scene)
  try {
    const seat = office.seats[0]!
    office.setAgent(seat, agent)
    office.walkTo(seat, 'coffee')
    steps(office, 1)
    expect(office.updateMovement(0, true)).toBe(false)
    expect(seat.away).toBeNull()
    expect(seat.occupant.visible).toBe(true)
    expect(scene.getObjectByName('walking-agent')).toBeUndefined()
    office.walkTo(seat, 'coffee')
    steps(office, 1)
    office.setAgent(seat, undefined)
    expect(seat.away).toBeNull()
    expect(scene.getObjectByName('walking-agent')).toBeUndefined()
    const leaving = scene.getObjectByName('departing-agent')!
    expect(leaving.visible).toBe(true)
    steps(office, 60)
    expect(scene.getObjectByName('departing-agent')).toBeUndefined()
  } finally {
    office.dispose()
  }
})

test('should take idle agents on pantry breaks by itself but never while they work', () => {
  const scene = new THREE.Scene()
  const office = createOffice(scene)
  try {
    office.setAgent(office.seats[0]!, agent)
    office.setAgent(office.seats[1]!, { ...agent, id: 'busy-agent' })
    updateWorkstationStatus(office.seats[1]!, 'running', false, 'busy')
    let broke = false
    const walked = new Set<boolean>()
    steps(office, 45, () => {
      const walking = Boolean(scene.getObjectByName('walking-agent'))
      if (walking) broke = true
      walked.add(office.seats[1]!.away !== null)
    })
    expect(broke).toBe(true)
    expect(walked).toEqual(new Set([false]))
  } finally {
    office.dispose()
  }
})

function fill(office: ReturnType<typeof createOffice>, count: number): void {
  for (let index = 0; index < count; index++) office.setAgent(office.seats[index]!, { ...agent, id: `walker-${index}` })
}

test('should seat at most two characters on the sofa and free a place when one leaves', () => {
  const scene = new THREE.Scene()
  const office = createOffice(scene)
  try {
    fill(office, 4)
    expect(office.walkTo(office.seats[0]!, 'sofa')).toBe(true)
    expect(office.walkTo(office.seats[1]!, 'sofa')).toBe(true)
    expect(office.walkTo(office.seats[2]!, 'sofa')).toBe(false)
    expect(office.seats[2]!.away).toBeNull()
    for (const index of [2, 3]) updateWorkstationStatus(office.seats[index]!, 'running', false, 'busy')
    const seated = new Set<number>()
    let both = false
    for (let frame = 0; frame < 30 * 60; frame++) {
      office.updateMovement(1 / 30, false)
      const sitting = scene.children[0]!.children.filter((child) => child.name === 'walking-agent' && child.position.x > 7.4 && child.position.y < -0.1)
      sitting.forEach((child) => seated.add(Math.round(child.position.z * 10)))
      if (sitting.length === 2) both = true
      expect(sitting.length).toBeLessThanOrEqual(2)
    }
    expect(both).toBe(true)
    expect([...seated].some((z) => Math.abs(z - 18) <= 1)).toBe(true)
    expect([...seated].some((z) => Math.abs(z - 33) <= 1)).toBe(true)
    expect(office.seats[0]!.away).toBeNull()
    expect(office.seats[1]!.away).toBeNull()
    updateWorkstationStatus(office.seats[2]!, 'idle', false, null)
    expect(office.walkTo(office.seats[2]!, 'sofa')).toBe(true)
  } finally {
    office.dispose()
  }
})

test('should lower the hips and bend the legs while sitting down on the sofa, then stand back up', () => {
  const scene = new THREE.Scene()
  const office = createOffice(scene)
  try {
    fill(office, 1)
    const seat = office.seats[0]!
    office.walkTo(seat, 'sofa')
    const heights: number[] = []
    const bends: number[] = []
    for (let frame = 0; frame < 30 * 60 && seat.away; frame++) {
      office.updateMovement(1 / 30, false)
      const figure = scene.children[0]!.children.find((child) => child.name === 'walking-agent')
      if (!figure || figure.position.x < 6.8) continue
      const body = figure.children[0]!
      heights.push(body.position.y + figure.position.y)
      bends.push((body.children.find((child) => child.rotation.x > 1) ? 1 : 0))
    }
    const standing = Math.max(...heights)
    const sitting = Math.min(...heights)
    expect(standing).toBeGreaterThan(0.8)
    expect(sitting).toBeLessThan(0.65)
    expect(bends.some(Boolean)).toBe(true)
    const first = heights.findIndex((height) => height === sitting)
    expect(heights.slice(0, first).some((height) => height > 0.8)).toBe(true)
    expect(heights.slice(first).some((height) => height > 0.8)).toBe(true)
    expect(heights.every((height, index) => index === 0 || Math.abs(height - heights[index - 1]!) < 0.08)).toBe(true)
  } finally {
    office.dispose()
  }
})

test('should let two characters browse the bookshelf with a book in hand and refuse a third', () => {
  const scene = new THREE.Scene()
  const office = createOffice(scene)
  try {
    fill(office, 3)
    expect(office.walkTo(office.seats[0]!, 'shelf')).toBe(true)
    expect(office.walkTo(office.seats[1]!, 'shelf')).toBe(true)
    expect(office.walkTo(office.seats[2]!, 'shelf')).toBe(false)
    updateWorkstationStatus(office.seats[2]!, 'running', false, 'busy')
    updateWorkstationAnimation(office.seats[0]!, 0, false)
    expect(office.seats[0]!.idleActivity).toBe('books')
    let books = 0
    let nearest = Infinity
    for (let frame = 0; frame < 30 * 60 && (office.seats[0]!.away || office.seats[1]!.away); frame++) {
      office.updateMovement(1 / 30, false)
      for (const figure of scene.children[0]!.children.filter((child) => child.name === 'walking-agent')) {
        nearest = Math.min(nearest, Math.hypot(figure.position.x - 5.6, figure.position.z + 4.7))
        const hand = figure.children[0]!.children.filter((child) => child.children.some((grandchild) => grandchild.visible && grandchild.children.length === 2 && (grandchild as THREE.Group).isGroup))
        if (hand.length) books++
      }
    }
    expect(nearest).toBeLessThan(0.05)
    expect(books).toBeGreaterThan(30)
    expect(office.seats[0]!.away).toBeNull()
    expect(office.seats[1]!.away).toBeNull()
    updateWorkstationStatus(office.seats[2]!, 'idle', false, null)
    expect(office.walkTo(office.seats[2]!, 'shelf')).toBe(true)
  } finally {
    office.dispose()
  }
})

test('should stand up from the sofa and hurry back when work arrives mid-rest', () => {
  const office = createOffice(new THREE.Scene())
  try {
    fill(office, 1)
    const seat = office.seats[0]!
    office.walkTo(seat, 'sofa')
    let frame = 0
    while (frame++ < 30 * 60) {
      office.updateMovement(1 / 30, false)
      if (seat.anchor.x > 7.4) break
    }
    expect(seat.anchor.x).toBeGreaterThan(7.4)
    updateWorkstationStatus(seat, 'running', false, 'urgent')
    steps(office, 25)
    expect(seat.away).toBeNull()
    expect(seat.occupant.visible).toBe(true)
  } finally {
    office.dispose()
  }
})

test('should carry the desk mug to the pantry, fill it there and set it back on the desk', () => {
  const scene = new THREE.Scene()
  const office = createOffice(scene)
  try {
    fill(office, 1)
    const seat = office.seats[0]!
    expect(seat.cup.visible).toBe(true)
    office.walkTo(seat, 'coffee')
    expect(seat.cup.visible).toBe(false)
    const mugVisible: boolean[] = []
    const filled: boolean[] = []
    for (let frame = 0; frame < 30 * 60 && seat.away; frame++) {
      office.updateMovement(1 / 30, false)
      // Whenever the mug is in the hand it must not also stand on the desk.
      if (scene.getObjectByName('walking-agent')?.getObjectByName('carried-prop')?.visible) expect(seat.cup.visible).toBe(false)
      const figure = scene.getObjectByName('walking-agent')
      const mug = figure?.getObjectByName('carried-prop')
      if (mug) {
        mugVisible.push(mug.visible)
        filled.push(mug.children[1]!.visible)
      }
    }
    expect(mugVisible[0]).toBe(true)
    expect(filled[0]).toBe(false)
    expect(filled.some(Boolean)).toBe(true)
    expect(seat.cup.visible).toBe(true)
    expect(seat.cup.children[1]!.visible).toBe(true)
  } finally {
    office.dispose()
  }
})

test('should return the mug empty when work interrupts the walk before the machine', () => {
  const office = createOffice(new THREE.Scene())
  try {
    fill(office, 1)
    const seat = office.seats[0]!
    office.walkTo(seat, 'coffee')
    steps(office, 1)
    updateWorkstationStatus(seat, 'running', false, 'urgent')
    steps(office, 5)
    expect(seat.away).toBeNull()
    expect(seat.cup.visible).toBe(true)
    expect(seat.cup.children[1]!.visible).toBe(false)
  } finally {
    office.dispose()
  }
})

test('should leave the desk mug alone on the bookshelf trip', () => {
  const office = createOffice(new THREE.Scene())
  try {
    fill(office, 1)
    const seat = office.seats[0]!
    office.walkTo(seat, 'shelf')
    for (let frame = 0; frame < 30 * 60 && seat.away; frame++) {
      office.updateMovement(1 / 30, false)
      expect(seat.cup.visible).toBe(true)
    }
  } finally {
    office.dispose()
  }
})

test('should take hot coffee to the sofa, sip it with the mug raised to the face and set it down at the desk', () => {
  const scene = new THREE.Scene()
  const office = createOffice(scene)
  try {
    fill(office, 1)
    const seat = office.seats[0]!
    office.walkTo(seat, 'sofa')
    expect(seat.cup.visible).toBe(false)
    let mugSteaming = false
    let raised = 0
    let lowered = 0
    for (let frame = 0; frame < 30 * 90 && seat.away; frame++) {
      office.updateMovement(1 / 30, false)
      const figure = scene.getObjectByName('walking-agent')
      const prop = figure?.getObjectByName('carried-prop')
      if (!figure || !prop?.visible) continue
      expect(seat.cup.visible).toBe(false)
      if (prop.getObjectByName('steam')?.visible) mugSteaming = true
      if (figure.position.x > 7.4) {
        const arm = figure.children[0]!.children.find((child) => child.children.includes(prop))!
        if (arm.rotation.x > 1.2) raised++
        else if (arm.rotation.x < 0.6) lowered++
      }
    }
    expect(mugSteaming).toBe(true)
    expect(raised).toBeGreaterThan(10)
    expect(lowered).toBeGreaterThan(10)
    expect(seat.cup.visible).toBe(true)
    expect(seat.steamUntil).toBeGreaterThan(0)
  } finally {
    office.dispose()
  }
})

test('should only steam desk mugs that are hot and show no steam under reduced motion', () => {
  const office = createOffice(new THREE.Scene())
  try {
    fill(office, 1)
    const seat = office.seats[0]!
    office.updateMovement(1 / 30, false)
    expect(seat.steam.visible).toBe(false)
    seat.steamUntil = 1e9
    office.updateMovement(1 / 30, false)
    expect(seat.steam.visible).toBe(true)
    const heights = new Set(seat.steam.children.map((puff) => puff.position.y.toFixed(3)))
    expect(heights.size).toBe(seat.steam.children.length)
    expect(seat.steam.children.every((puff) => puff.position.y > 0.14 && puff.scale.x > 0)).toBe(true)
    office.updateMovement(1 / 30, true)
    expect(seat.steam.visible).toBe(false)
  } finally {
    office.dispose()
  }
})
