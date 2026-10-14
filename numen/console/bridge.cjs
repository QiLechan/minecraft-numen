'use strict'

// stdout 是 JVM 的 JSONL 通道;依赖库与登录提示的输出只进 stderr。
console.log = (...args) => console.error(...args)
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const readline = require('node:readline')
const { customPackets } = require('./protocol.cjs')
const { specs, execute, snapshot, stopBody, configureMovement } = require('./tools.cjs')
const send = message => process.stdout.write(JSON.stringify(message) + '\n')

if (process.argv.includes('--versions')) {
  send({ oldest: mineflayer.oldestSupportedVersion, latest: mineflayer.latestSupportedVersion, tested: mineflayer.testedVersions })
} else {
  let bot
  let ready = false
  let ending = false
  let action = null
  let consentId = 0
  let lastStateAt = 0
  const pending = new Map()
  const input = readline.createInterface({ input: process.stdin, terminal: false })
  function cancel (reason) {
    if (action) action.abort(reason)
    if (bot?.entity) stopBody(bot)
    for (const request of pending.values()) request.reject(new Error(reason))
    pending.clear()
  }
  function finish (reason, failed = false) {
    if (ending) return
    ending = true
    ready = false
    cancel(reason)
    send({ kind: 'end', reason, failed })
    bot?.end(reason)
    input.close()
    // 断开连接后关闭认证、物理与网络定时器,不留下后台客户端。
    setTimeout(() => process.exit(failed ? 1 : 0), 200)
  }
  function consent (target, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error(signal.reason))
      const id = String(++consentId)
      const abort = () => { pending.delete(id); reject(new Error(signal.reason)) }
      signal.addEventListener('abort', abort, { once: true })
      pending.set(id, {
        resolve: () => { signal.removeEventListener('abort', abort); resolve() },
        reject: error => { signal.removeEventListener('abort', abort); reject(error) }
      })
      send({ kind: 'consent', id, action: target })
    })
  }
  function start (config) {
    if (bot) throw new Error('Client already initialized')
    bot = mineflayer.createBot({
      customPackets,
      host: config.host, port: config.port, username: config.username, auth: config.auth,
      version: config.version === 'auto' ? false : config.version,
      profilesFolder: config.profilesFolder,
      respawn: false,
      onMsaCode: code => send({ kind: 'login', message: code.message })
    })
    bot.loadPlugin(pathfinder)
    // Mineflayer 的 spawn 在同一包的 health 更新之前发出,等包处理完再交现场。
    bot.on('spawn', () => queueMicrotask(() => {
      if (ending) return
      configureMovement(bot)
      ready = true
      send({ kind: 'spawn', tools: specs, state: snapshot(bot) })
    }))
    bot.on('physicsTick', () => {
      if (ready && Date.now() - lastStateAt >= 1000) {
        lastStateAt = Date.now()
        send({ kind: 'state', state: snapshot(bot) })
      }
    })
    bot.on('chat', (username, message) => {
      if (username !== bot.username) send({ kind: 'chat', username, message })
    })
    bot.on('whisper', (username, message) => {
      if (username !== bot.username) send({ kind: 'chat', username, message })
    })
    bot.on('messagestr', (message, position) => {
      if (position !== 'chat') send({ kind: 'server_message', message })
    })
    bot.on('death', () => {
      ready = false
      cancel('Body died')
      send({ kind: 'death', state: snapshot(bot) })
    })
    bot.on('game', () => { if (ready) send({ kind: 'state', state: snapshot(bot) }) })
    bot.on('respawn', () => { ready = false; cancel('Body left the previous dimension') })
    bot.on('forcedMove', () => {
      if (ready) send({ kind: 'server_message', message: `Server moved the body to ${bot.entity.position}`, state: snapshot(bot) })
    })
    bot.on('kicked', reason => finish(`Kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`, true))
    bot.on('error', error => finish(error.message, true))
    bot.on('end', reason => finish(String(reason)))
  }
  async function call (request) {
    if (!ready) return send({ kind: 'result', id: request.id, success: false, message: 'Client has not spawned' })
    if (action) return send({ kind: 'result', id: request.id, success: false, message: 'Body is still settling the previous action' })
    const controller = new AbortController()
    const ctx = {
      check () { if (controller.signal.aborted) throw new Error(controller.signal.reason) },
      permit: target => consent(target, controller.signal),
      abort (why) {
        controller.abort(why)
        stopBody(bot)
      }
    }
    action = ctx
    const timer = setTimeout(() => ctx.abort('Action timed out after 120 seconds'), 120000)
    const aborted = new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error(controller.signal.reason)), { once: true }))
    // 超时先交失败回执,身体槽要等真正的操作结束才归还,避免新操作与旧操作相互覆盖。
    const operation = execute(bot, request.name, request.args, ctx).then(result => {
      if (controller.signal.aborted) send({ kind: 'server_message', message: `Interrupted ${request.name} finished its current atomic step: ${JSON.stringify(result)}`, state: snapshot(bot) })
      return result
    }, error => {
      if (controller.signal.aborted) send({ kind: 'server_message', message: `Interrupted ${request.name} settled: ${error.message}`, state: snapshot(bot) })
      throw error
    }).finally(() => {
      if (action === ctx) action = null
      clearTimeout(timer)
    })
    try {
      const result = await Promise.race([operation, aborted])
      send({ kind: 'result', id: request.id, success: true, data: result, state: snapshot(bot) })
    } catch (error) {
      send({ kind: 'result', id: request.id, success: false, message: error.message, state: snapshot(bot) })
    } finally {
      clearTimeout(timer)
    }
  }
  input.on('line', line => {
    try {
      const request = JSON.parse(line)
      switch (request.kind) {
        case 'init': start(request); break
        case 'call': void call(request); break
        case 'consent': {
          const reply = pending.get(request.id)
          if (reply) {
            pending.delete(request.id)
            if (request.allow) reply.resolve()
            else reply.reject(new Error('Permission denied by owner'))
          }
          break
        }
        case 'stop': cancel('Stopped by owner'); send({ kind: 'state', state: snapshot(bot) }); break
        case 'respawn': if (bot && !ready) bot.respawn(); break
        case 'quit': finish('Owner disconnected'); break
        default: throw new Error(`Unknown bridge request: ${request.kind}`)
      }
    } catch (error) { finish(`Bridge input error: ${error.message}`, true) }
  })
  input.on('close', () => finish('Console closed'))
  process.on('SIGTERM', () => finish('Console terminated'))
  process.on('unhandledRejection', error => finish(error.message, true))
  process.on('uncaughtException', error => finish(error.message, true))
}
