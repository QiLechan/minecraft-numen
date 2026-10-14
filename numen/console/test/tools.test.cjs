'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { execute, configureMovement } = require('../tools.cjs')
const data = require('minecraft-data')('1.21.1')
const { EventEmitter } = require('node:events')

function fixture () {
  const dirt = { name: 'dirt', type: data.blocksByName.dirt.id, stateId: 10, position: new Vec3(0, 0, 0), boundingBox: 'block' }
  const calls = []
  const bot = {
    _client: new EventEmitter(),
    entity: { position: new Vec3(0, 0, 1) }, health: 20, food: 20, game: { dimension: 'overworld' }, registry: data,
    entities: { 7: { id: 7, name: 'cow', position: new Vec3(0, 0, 2), height: 1 } },
    inventory: { items: () => [] }, blockAt: () => dirt, canDigBlock: () => true,
    pathfinder: { bestHarvestTool: () => null, setMovements: m => calls.push(m) },
    chat: message => calls.push(['chat', message]), attack: entity => calls.push(['attack', entity.id]),
    lookAt: async () => {}, dig: async () => {
      calls.push(['dig'])
      bot.blockAt = () => ({ ...dirt, type: 0, name: 'air' })
      bot._client.emit('block_change', { location: dirt.position, type: 0 })
    },
    closeWindow: () => {}, stopDigging: () => {}, clearControlStates: () => {}
  }
  return { bot, dirt, calls }
}
const context = permit => ({ check () {}, permit, abort () {} })

test('permission denial sends no world-changing action or command', async () => {
  for (const [name, args] of [['dig', { x: 0, y: 0, z: 0 }], ['attack', { entityId: 7 }], ['chat', { message: '/kill @e' }]]) {
    const { bot, calls } = fixture()
    await assert.rejects(execute(bot, name, args, context(async () => { throw new Error('Denied') })), /Denied/)
    assert.deepEqual(calls, [])
  }
})

test('plain chat is sent; a slash command is authorized with its full line', async () => {
  const { bot, calls } = fixture()
  const actions = []
  await execute(bot, 'chat', { message: 'hello' }, context(async a => actions.push(a)))
  await execute(bot, 'chat', { message: '/msg owner hello' }, context(async a => actions.push(a)))
  assert.deepEqual(actions, [{ kind: 'command', target: { line: '/msg owner hello' } }])
  assert.equal(calls.length, 2)
  await assert.rejects(execute(bot, 'chat', { message: 'hello\n/op bot' }, context(async () => {})), /one line/)
})

test('block changed during consent is rejected before digging', async () => {
  const { bot, dirt, calls } = fixture()
  await assert.rejects(execute(bot, 'dig', { x: 0, y: 0, z: 0 }, context(async () => { dirt.stateId = 11 })), /changed/)
  assert.deepEqual(calls, [])
})

test('successful dig reports the measured inventory and final body', async () => {
  const { bot } = fixture()
  const result = await execute(bot, 'dig', { x: 0, y: 0, z: 0 }, context(async () => {}))
  assert.equal(result.broken, 'dirt')
  assert.deepEqual(result.body.inventory, [])
  assert.equal(result.body.health, 20)
})

test('attack reports a sent strike without claiming unobserved damage', async () => {
  const { bot } = fixture()
  const result = await execute(bot, 'attack', { entityId: 7 }, context(async () => {}))
  assert.equal(result.confirmedDamage, false)
})

test('server refusal is reported even if the client predicts air locally', async () => {
  const { bot, dirt } = fixture()
  bot.dig = async () => {
    bot.blockAt = () => ({ ...dirt, type: 0, name: 'air' })
    bot._client.emit('block_change', { location: dirt.position, type: dirt.stateId })
  }
  await assert.rejects(execute(bot, 'dig', { x: 0, y: 0, z: 0 }, context(async () => {})), /Server refused/)
  assert.equal(bot._client.listenerCount('block_change'), 0)
})

test('pathfinding cannot bypass permissions with automatic world edits', () => {
  const { bot, calls } = fixture()
  configureMovement(bot)
  const movement = calls[0]
  assert.equal(movement.canDig, false)
  assert.equal(movement.canOpenDoors, false)
  assert.equal(movement.allow1by1towers, false)
  assert.deepEqual(movement.scafoldingBlocks, [])
})

test('invalid target, count or extra argument fails before permission', async () => {
  const { bot } = fixture()
  let permits = 0
  for (const [name, args] of [['dig', { x: 0.5, y: 0, z: 0 }], ['drop', { item: 'dirt', count: -1 }], ['chat', { message: 'hi', executable: 'op bot' }], ['container', { x: 0, y: 0, z: 0, operation: 'withdraw', count: 2 }]]) {
    await assert.rejects(execute(bot, name, args, context(async () => { permits++ })))
  }
  assert.equal(permits, 0)
})

test('a stop between craft iterations prevents every remaining inventory change', async () => {
  const { bot } = fixture()
  let stopped = false
  let crafts = 0
  bot.recipesFor = () => [{}]
  bot.craft = async (recipe, count) => { assert.equal(count, 1); crafts++; stopped = true }
  const ctx = { check () { if (stopped) throw new Error('Stopped') }, permit: async () => {} }
  await assert.rejects(execute(bot, 'craft', { item: 'oak_planks', count: 3 }, ctx), /Stopped/)
  assert.equal(crafts, 1)
})
