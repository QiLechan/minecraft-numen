'use strict'

const { Vec3 } = require('vec3')
const { Movements, goals } = require('mineflayer-pathfinder')

const string = { type: 'string', minLength: 1 }
const integer = { type: 'integer' }
const coordinates = { x: integer, y: integer, z: integer }
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const specs = [
  ['status', 'Read position, health, food, dimension, held item and inventory.', {}, []],
  ['scan', 'Read nearby visible entities and loaded blocks. Supply a block name to find its coordinates; does not load remote chunks.', { block: string, radius: { type: 'integer', minimum: 1, maximum: 32 } }, []],
  ['move', 'Walk to a block coordinate within range (0-4). Never digs, places, opens doors or teleports. Returns actual final position; timeoutSeconds is 1-60.', { ...coordinates, range: { type: 'integer', minimum: 0, maximum: 4 }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 60 } }, ['x', 'y', 'z']],
  ['dig', 'Break exactly one block within reach, selecting an available harvesting tool. Permission is requested before breaking. Returns actual world and inventory state.', coordinates],
  ['place', 'Place one inventory block at an empty coordinate within reach, using an adjacent solid block. Supply the inventory item name.', { ...coordinates, item: string }],
  ['craft', 'Craft an available recipe count times (1-64). Supply item name and optional nearby crafting-table coordinates. Does not move or acquire ingredients.', { item: string, count: { type: 'integer', minimum: 1, maximum: 64 }, table: schema(coordinates) }, ['item']],
  ['equip', 'Equip an inventory item in hand, off-hand, head, torso, legs or feet.', { item: string, destination: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] } }, ['item']],
  ['eat', 'Consume the named inventory food. Does not choose food for you.', { item: string }],
  ['interact', 'Right-click one block at coordinates or one nearby entity by id. Permission is requested for the specific target.', { ...coordinates, entityId: integer }, []],
  ['container', 'Open a reachable container: list its contents, withdraw, or deposit an item count (1-2304). Each world action is authorized by the permission layer. Always closes the window.', { ...coordinates, operation: { type: 'string', enum: ['list', 'withdraw', 'deposit'] }, item: string, count: { type: 'integer', minimum: 1, maximum: 2304 } }, ['x', 'y', 'z', 'operation']],
  ['drop', 'Drop a specific number (1-2304) of an inventory item. Permission is requested first.', { item: string, count: { type: 'integer', minimum: 1, maximum: 2304 } }],
  ['attack', 'Strike one entity by id once within melee reach. Does not pursue it. Permission is requested first.', { entityId: integer }],
  ['chat', 'Send a public chat line. A line beginning with / is a server command and requires permission.', { message: string }],
  ['stop', 'Stop movement and digging. Returns measured body state.', {}, []]
].map(([name, description, properties, required]) => ({ name, description, parameters: schema(properties, required) }))

function snapshot (bot) {
  return {
    connected: !!bot.entity, version: bot.version, username: bot.username,
    position: bot.entity?.position, dimension: bot.game?.dimension,
    health: bot.health, food: bot.food, oxygen: bot.oxygenLevel,
    heldItem: itemView(bot.heldItem), inventory: bot.inventory?.items().map(itemView) ?? []
  }
}
function itemView (item) { return item && { name: item.name, count: item.count, slot: item.slot } }
function stopBody (bot) {
  bot.pathfinder?.setGoal(null)
  bot.stopDigging()
  bot.deactivateItem?.()
  bot.clearControlStates()
  if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
}
function position (value) {
  for (const axis of ['x', 'y', 'z']) {
    if (!Number.isSafeInteger(value[axis]) || Math.abs(value[axis]) > 30000000) throw new Error(`Invalid ${axis} coordinate`)
  }
  return new Vec3(value.x, value.y, value.z)
}
function quantity (n, max, defaultValue) {
  n = n === undefined ? defaultValue : n
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Count must be an integer from 1 to ${max}`)
  return n
}
function inventoryItem (bot, name) {
  if (typeof name !== 'string' || !name) throw new Error('Item name is required')
  const item = bot.inventory.items().find(i => i.name === name.replace(/^minecraft:/, ''))
  if (!item) throw new Error(`Not in inventory: ${name}`)
  return item
}
function reachableBlock (bot, args) {
  const pos = position(args)
  if (bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.5) throw new Error('Block is out of reach; move closer')
  const block = bot.blockAt(pos)
  if (!block) throw new Error('Chunk is not loaded')
  return block
}
function reachableEntity (bot, id) {
  if (!Number.isInteger(id)) throw new Error('entityId must be an integer')
  const entity = bot.entities[id]
  if (!entity || entity === bot.entity) throw new Error('Entity does not exist or is self')
  if (entity.position.distanceTo(bot.entity.position) > 3) throw new Error('Entity is out of reach')
  return entity
}
function validate (name, args) {
  const spec = specs.find(s => s.name === name)
  if (!spec) throw new Error(`Unknown tool: ${name}`)
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object')
  for (const key of spec.parameters.required) if (!(key in args)) throw new Error(`Missing argument: ${key}`)
  for (const [key, value] of Object.entries(args)) {
    const rule = spec.parameters.properties[key]
    if (!rule) throw new Error(`Unknown argument: ${key}`)
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum))) throw new Error(`Invalid ${key}`)
    if (rule.type === 'string' && (typeof value !== 'string' || !value.length || (rule.enum && !rule.enum.includes(value)))) throw new Error(`Invalid ${key}`)
    if (rule.type === 'object') position(value)
  }
}

function configureMovement (bot) {
  const movement = new Movements(bot)
  // 寻路只走路。挖、放、右键必须由模型明确派发,再经过权限层。
  movement.canDig = false
  movement.allow1by1towers = false
  movement.allowFreeMotion = false
  movement.allowParkour = false
  movement.canOpenDoors = false
  movement.scafoldingBlocks = []
  bot.pathfinder.setMovements(movement)
}

async function execute (bot, name, a, ctx) {
  validate(name, a)
  ctx.check()
  if (!bot.entity || bot.health <= 0) throw new Error('Body is not alive in the world')
  const permit = async (kind, target) => {
    await ctx.permit({ kind, target })
    ctx.check()
  }
  const blockPermit = async (kind, block, extra = {}) => {
    const state = block.stateId
    await permit(kind, { position: block.position, block: block.name, ...extra })
    const current = reachableBlock(bot, block.position)
    if (current.stateId !== state) throw new Error('Target block changed while awaiting permission')
    return current
  }
  switch (name) {
    case 'status': return snapshot(bot)
    case 'scan': {
      const radius = a.radius ?? 16
      const entities = Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(bot.entity.position) <= radius)
        .sort((x, y) => x.position.distanceTo(bot.entity.position) - y.position.distanceTo(bot.entity.position))
        .slice(0, 64).map(e => ({ id: e.id, name: e.name, username: e.username, position: e.position }))
      let blocks = []
      if (a.block) {
        const type = bot.registry.blocksByName[a.block.replace(/^minecraft:/, '')]
        if (!type) throw new Error(`Unknown block for ${bot.version}: ${a.block}`)
        blocks = bot.findBlocks({ matching: type.id, maxDistance: radius, count: 64 }).map(p => ({ name: type.name, position: p }))
      }
      return { entities, blocks, radius }
    }
    case 'move': {
      const pos = position(a)
      const range = a.range ?? 1
      const goal = range === 0 ? new goals.GoalBlock(pos.x, pos.y, pos.z) : new goals.GoalNear(pos.x, pos.y, pos.z, range)
      configureMovement(bot)
      const timer = setTimeout(() => ctx.abort('Movement timed out'), (a.timeoutSeconds ?? 30) * 1000)
      try { await bot.pathfinder.goto(goal) } finally { clearTimeout(timer) }
      ctx.check()
      if (!goal.isEnd(bot.entity.position.floored())) throw new Error('Path ended before reaching the requested coordinate')
      return snapshot(bot)
    }
    case 'dig': {
      let block = reachableBlock(bot, a)
      if (!bot.canDigBlock(block)) throw new Error('Block cannot be dug from here')
      block = await blockPermit('break', block)
      const tool = bot.pathfinder.bestHarvestTool(block)
      if (tool) await bot.equip(tool, 'hand')
      ctx.check()
      await confirmedDig(bot, block, ctx)
      return { broken: block.name, position: block.position, body: snapshot(bot) }
    }
    case 'place': {
      const item = inventoryItem(bot, a.item)
      let target = reachableBlock(bot, a)
      if (!['air', 'cave_air', 'void_air'].includes(target.name)) throw new Error('Placement target must be empty')
      if (!bot.registry.blocksByName[item.name]) throw new Error('Item is not a placeable block')
      target = await blockPermit('place', target, { item: item.name })
      const faces = [new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
      const face = faces.find(f => bot.blockAt(target.position.minus(f))?.boundingBox === 'block')
      if (!face) throw new Error('No adjacent solid support block')
      const reference = reachableBlock(bot, target.position.minus(face))
      await bot.equip(item, 'hand')
      ctx.check()
      await bot.placeBlock(reference, face)
      const placed = bot.blockAt(target.position)
      if (!placed || ['air', 'cave_air', 'void_air'].includes(placed.name)) throw new Error('Server did not confirm placement')
      return { placed: placed.name, position: target.position, body: snapshot(bot) }
    }
    case 'craft': {
      const type = bot.registry.itemsByName[a.item.replace(/^minecraft:/, '')]
      if (!type) throw new Error(`Unknown item: ${a.item}`)
      const count = quantity(a.count, 64, 1)
      const table = a.table ? reachableBlock(bot, a.table) : null
      if (table && table.name !== 'crafting_table') throw new Error('The specified block is not a crafting table')
      const recipe = bot.recipesFor(type.id, null, 1, table)[0]
      if (!recipe) throw new Error('No recipe with the available ingredients/table')
      await permit('craft', { item: type.name, count, table: table?.position })
      if (table && reachableBlock(bot, a.table).name !== 'crafting_table') throw new Error('Crafting table changed')
      for (let i = 0; i < count; i++) {
        ctx.check()
        await bot.craft(recipe, 1, table)
      }
      ctx.check()
      return snapshot(bot)
    }
    case 'equip': await bot.equip(inventoryItem(bot, a.item), a.destination ?? 'hand'); return snapshot(bot)
    case 'eat': {
      const item = inventoryItem(bot, a.item)
      if (!bot.registry.foodsByName[item.name]) throw new Error('Item is not food')
      await permit('consume', { item: item.name })
      await bot.equip(item, 'hand')
      ctx.check()
      await bot.consume()
      return snapshot(bot)
    }
    case 'interact': {
      if (a.entityId !== undefined) {
        if (['x', 'y', 'z'].some(k => k in a)) throw new Error('Choose either block coordinates or entityId')
        const entity = reachableEntity(bot, a.entityId)
        await permit('use_entity', { id: entity.id, uuid: entity.uuid, name: entity.name, username: entity.username })
        if (reachableEntity(bot, a.entityId) !== entity) throw new Error('Target entity changed')
        await bot.activateEntity(entity)
      } else {
        const block = await blockPermit('use_block', reachableBlock(bot, a))
        await bot.activateBlock(block)
      }
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
      return snapshot(bot)
    }
    case 'container': {
      const count = a.operation === 'list' ? 0 : quantity(a.count, 2304)
      const type = a.operation === 'list' ? null : bot.registry.itemsByName[a.item?.replace(/^minecraft:/, '')]
      if (a.operation !== 'list' && !type) throw new Error('Container item is required and must be a known item')
      const block = await blockPermit('use_block', reachableBlock(bot, a))
      if (a.operation !== 'list') await blockPermit(a.operation === 'withdraw' ? 'take' : 'deposit', block, { item: a.item, count })
      ctx.check()
      const window = await bot.openContainer(block)
      try {
        ctx.check()
        if (a.operation !== 'list') {
          await window[a.operation](type.id, null, count)
        }
        return { contents: window.containerItems().map(itemView), body: snapshot(bot) }
      } finally { window.close() }
    }
    case 'drop': {
      const item = inventoryItem(bot, a.item)
      const count = quantity(a.count, 2304)
      await permit('drop', { item: item.name, count })
      await bot.toss(item.type, item.metadata, count)
      return snapshot(bot)
    }
    case 'attack': {
      const entity = reachableEntity(bot, a.entityId)
      await permit('attack', { id: entity.id, uuid: entity.uuid, name: entity.name, username: entity.username })
      if (reachableEntity(bot, a.entityId) !== entity) throw new Error('Target entity changed')
      await bot.lookAt(entity.position.offset(0, entity.height / 2, 0))
      ctx.check()
      bot.attack(entity)
      return { sent: 'one attack', target: entity.id, confirmedDamage: false, body: snapshot(bot) }
    }
    case 'chat': {
      if (/\r|\n/.test(a.message) || a.message.length > 256) throw new Error('Chat must be one line of at most 256 characters')
      if (a.message.startsWith('/')) await permit('command', { line: a.message })
      bot.chat(a.message)
      return { sent: a.message }
    }
    case 'stop': stopBody(bot); return snapshot(bot)
  }
}

async function confirmedDig (bot, block, ctx) {
  // Mineflayer 会在挖掘时间到时乐观地把本地格子改成空气。只有服务端方块包才是确认。
  let answer
  let notify
  const changed = new Promise(resolve => { notify = resolve })
  const update = packet => {
    if (packet.location.x === block.position.x && packet.location.y === block.position.y && packet.location.z === block.position.z) {
      answer = packet.type
      if (answer === 0) notify()
    }
  }
  bot._client.on('block_change', update)
  let timer
  try {
    await bot.dig(block)
    ctx.check()
    if (answer !== 0) {
      await Promise.race([changed, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(answer === undefined
          ? 'Server did not confirm the block was broken' : 'Server refused to break the block')), 5000)
      })])
    }
    ctx.check()
    if (answer !== 0) throw new Error('Server refused to break the block')
  } finally {
    clearTimeout(timer)
    bot._client.removeListener('block_change', update)
  }
}
module.exports = { specs, execute, snapshot, stopBody, configureMovement, validate }
