'use strict'

const data = require('minecraft-data')('1.21.1')

// 1.21.1 TrimMaterial.DIRECT_STREAM_CODEC:浮点 itemModelIndex 在 ingredient 与覆盖表之间;
// 覆盖表的键是 ARMOR_MATERIAL 注册表编号,不是字符串。修正依赖中的线格式定义,不跳过坏包。
const trimMaterial = ['container', [
  { name: 'assetName', type: 'string' },
  { name: 'ingredientId', type: 'varint' },
  { name: 'itemModelIndex', type: 'f32' },
  { name: 'overrideArmorAssets', type: ['array', { countType: 'varint', type: ['container', [
    { name: 'key', type: 'varint' },
    { name: 'value', type: 'string' }
  ]] }] },
  { name: 'description', type: 'anonymousNbt' }
]]

// RecipeSerializer 的注册顺序里没有 banneraddpattern;它会把后面的烹饪配方错当成物品组件。
// 其余配方结构沿用依赖的定义,只替换编号表。
const recipes = structuredClone(data.protocol.play.toClient.types.packet_declare_recipes)
const recipeFields = recipes[1][0].type[1].type[1]
const dependencyNames = Object.values(recipeFields.find(field => field.name === 'type').type[1].mappings)
const names = dependencyNames.filter(name => name !== 'minecraft:crafting_special_banneraddpattern')
recipeFields.find(field => field.name === 'type').type = 'numenRecipeSerializer'

module.exports = { customPackets: { '1.21': {
  types: {
    ArmorTrimMaterial: trimMaterial,
    numenRecipeSerializer: ['mapper', { type: 'varint', mappings: Object.fromEntries(names.map((name, id) => [id, name])) }]
  },
  play: { toClient: { types: { packet_declare_recipes: recipes } } }
} } }
