'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const readline = require('node:readline')
const path = require('node:path')
const { serverFor } = require('./server.cjs')

function messages (child) {
  const buffered = []
  const waiters = []
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line)
    const index = waiters.findIndex(w => w.match(value))
    if (index < 0) buffered.push(value)
    else { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(value) }
  })
  return match => {
    const index = buffered.findIndex(match)
    if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, timer: setTimeout(() => reject(new Error(`Timed out; messages: ${JSON.stringify(buffered)}`)), 10000) }
      waiters.push(waiter)
    })
  }
}

for (const version of ['1.8.8', '1.12.2', '1.20.4', '1.21.1', '26.1']) {
  test(`network bridge auto-detects, spawns, chats and disconnects on ${version}`, { timeout: 20000 }, async t => {
    const server = await serverFor(version)
    const child = spawn(process.execPath, [path.join(__dirname, '../bridge.cjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', text => { stderr += text })
    t.after(() => { child.kill(); server.close() })
    const next = messages(child)
    const send = data => child.stdin.write(JSON.stringify(data) + '\n')
    send({ kind: 'init', host: '127.0.0.1', port: server.socketServer.address().port, auth: 'offline', username: 'Numen', version: 'auto' })
    const joined = await next(m => m.kind === 'spawn' || m.kind === 'end')
    assert.equal(joined.kind, 'spawn', JSON.stringify(joined) + stderr)
    assert.equal(joined.state.health, 20)
    assert.equal(joined.state.version, version)
    assert.ok(joined.tools.some(s => s.name === 'dig'))
    const chat = once(server, 'chatLine')
    send({ kind: 'call', id: '1', name: 'chat', args: { message: 'hello from Numen' } })
    assert.equal((await next(m => m.kind === 'result' && m.id === '1')).success, true)
    assert.equal((await chat)[0], 'hello from Numen')
    send({ kind: 'call', id: '2', name: 'chat', args: { message: '/say gated' } })
    const consent = await next(m => m.kind === 'consent')
    assert.equal(consent.action.kind, 'command')
    send({ kind: 'consent', id: consent.id, allow: false })
    assert.equal((await next(m => m.kind === 'result' && m.id === '2')).success, false)
    send({ kind: 'call', id: '3', name: 'chat', args: { message: '/say stop-while-waiting' } })
    await next(m => m.kind === 'consent')
    send({ kind: 'stop' })
    assert.equal((await next(m => m.kind === 'result' && m.id === '3')).success, false)
    send({ kind: 'quit' })
    const exit = await once(child, 'exit')
    assert.equal(exit[0], 0, stderr)
  })
}

test('connection failure exits with a visible reason', { timeout: 15000 }, async t => {
  const server = await serverFor('1.8.8')
  const port = server.socketServer.address().port
  server.close()
  const child = spawn(process.execPath, [path.join(__dirname, '../bridge.cjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  t.after(() => child.kill())
  const next = messages(child)
  child.stdin.write(JSON.stringify({ kind: 'init', host: '127.0.0.1', port, auth: 'offline', username: 'Numen', version: '1.8.8' }) + '\n')
  const result = await next(m => m.kind === 'end')
  assert.equal(result.failed, true)
  assert.match(result.reason, /ECONNREFUSED/)
  assert.equal((await once(child, 'exit'))[0], 1)
})
