'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSerializer } = require('minecraft-protocol/src/transforms/serializer')
const { customPackets } = require('../protocol.cjs')

test('1.21.1 inline trim material reads the vanilla float and registry-id map without losing alignment', () => {
  const proto = createSerializer({ state: 'play', isServer: true, version: '1.21.1', customPackets }).proto
  // asset="gold", ingredient=5, itemModelIndex=0.5, override registry id 1="abc", empty NBT description.
  const raw = Buffer.from('04676f6c64053f0000000101036162630a00', 'hex')
  const decoded = proto.parsePacketBuffer('ArmorTrimMaterial', raw)
  assert.equal(decoded.metadata.size, raw.length)
  assert.equal(decoded.data.itemModelIndex, 0.5)
  assert.deepEqual(decoded.data.overrideArmorAssets, [{ key: 1, value: 'abc' }])
  assert.deepEqual(proto.createPacketBuffer('ArmorTrimMaterial', decoded.data), raw)
})

test('1.21.1 recipe serializer 11 is shield decoration; cooking IDs keep their vanilla order', () => {
  const proto = createSerializer({ state: 'play', isServer: true, version: '1.21.1', customPackets }).proto
  const raw = Buffer.concat([Buffer.from([0x77, 1, 4]), Buffer.from('test'), Buffer.from([11, 0])])
  const decoded = proto.parsePacketBuffer('packet', raw)
  assert.equal(decoded.metadata.size, raw.length)
  assert.equal(decoded.data.params.recipes[0].type, 'minecraft:crafting_special_shielddecoration')
  assert.equal(proto.parsePacketBuffer('numenRecipeSerializer', Buffer.from([15])).data, 'minecraft:smelting')
})
