'use strict'
// 协议测试端点:只提供登录、出生与聊天,不是原版服务器的世界模拟。
const mc = require('minecraft-protocol')
const data = require('minecraft-data')
const { once } = require('node:events')

async function serverFor (version) {
  const server = mc.createServer({ host: '127.0.0.1', port: 0, version, 'online-mode': false })
  const registry = data(version)
  server.on('playerJoin', client => {
    client.write('login', {
      ...(registry.loginPacket ?? {}), entityId: client.id,
      levelType: 'default', gameMode: 0, previousGameMode: 0, dimension: 0,
      difficulty: 0, maxPlayers: 20, reducedDebugInfo: false, enableRespawnScreen: true
    })
    const timer = setTimeout(() => {
      client.write('position', { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: 0, teleportId: 1 })
      client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
    }, 100)
    client.on('end', () => clearTimeout(timer))
    client.on('chat', packet => server.emit('chatLine', packet.message))
    client.on('chat_message', packet => server.emit('chatLine', packet.message))
    client.on('chat_command', packet => server.emit('commandLine', packet.command))
  })
  await once(server, 'listening')
  return server
}
module.exports = { serverFor }

if (require.main === module) {
  serverFor(process.argv[2] ?? '1.21.1').then(server => {
    console.log(server.socketServer.address().port)
    process.on('SIGTERM', () => { server.close(); process.exit(0) })
  }).catch(error => { console.error(error); process.exit(1) })
}
