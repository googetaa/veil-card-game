import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { Server } from 'socket.io'

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
const httpServer = createServer((request, response) => {
  const requested = new URL(request.url || '/', 'http://localhost').pathname
  const file = join(process.cwd(), 'dist', requested === '/' ? 'index.html' : requested)
  const fallback = join(process.cwd(), 'dist', 'index.html')
  const target = existsSync(file) && !file.endsWith('dist') ? file : fallback
  try { response.writeHead(200, { 'content-type': contentTypes[extname(target)] || 'application/octet-stream' }); response.end(readFileSync(target)) }
  catch { response.writeHead(404); response.end('Run npm run build before npm start.') }
})
const io = new Server(httpServer, { cors: { origin: '*' } })
const rooms = new Map()
const ranks = ['A', 'K', 'Q', 'J', '10', '9', '8', '7']
const suits = ['♠', '♥', '♦', '♣']
const avatars = ['✦', '✿', '◈', '✧', '❋', '◆', '✶', '❂']
const specialNames = ['WILD', 'SPY', 'SHIELD', 'SWAP', 'REVERSE', 'TRUTH', 'DOUBLE']

function roomCode() { let code; do code = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join(''); while (rooms.has(code)); return code }
function deck() { return [...ranks.flatMap(rank => suits.map(suit => ({ id: crypto.randomUUID(), rank, suit }))), ...specialNames.map(special => ({ id: crypto.randomUUID(), rank: 'A', suit: '♠', special }))].sort(() => Math.random() - .5) }
function newGame(players) {
  const cards = deck()
  // Deal fewer cards when there are more players so the deck doesn't run dry
  const handSize = players.length >= 5 ? 4 : 5
  return {
    players: players.map(player => ({ ...player, hand: cards.splice(0, handSize), shield: false })),
    current: 0, direction: 1, deck: cards, discard: [],
    phase: 'select', lastClaim: null, winner: null, round: 1,
    log: ['The table is set. Trust nobody.']
  }
}
function next(game, from = game.current) { return (from + game.direction + game.players.length) % game.players.length }
function ensureDeck(game) {
  // If deck is empty but there are discarded cards, reshuffle them back in
  if (game.deck.length === 0 && game.discard.length > 0) {
    game.deck = game.discard.sort(() => Math.random() - .5)
    game.discard = []
    game.log.unshift('Deck exhausted — discards reshuffled.')
  }
}
function claimIsTruthful(claim) {
  return claim.cards.every(card => card.special ? card.special === 'WILD' : card.rank === claim.rank)
}
function publicState(room, socketId) {
  const game = room.game; if (!game) return null
  return {
    current: game.current, direction: game.direction, deckCount: game.deck.length, discardCount: game.discard.length,
    phase: game.phase, round: game.round, winner: game.winner,
    lastClaim: game.lastClaim && { playerId: game.lastClaim.playerId, rank: game.lastClaim.rank, count: game.lastClaim.count },
    log: game.log.slice(0, 8),
    players: game.players.map(player => ({
      id: player.id, name: player.name, avatar: player.avatar,
      hand: player.id === socketId ? player.hand : [],
      handCount: player.hand.length, shield: player.shield
    }))
  }
}
function emitRoom(room) {
  for (const player of room.players) {
    io.to(player.id).emit('room:update', {
      code: room.code, hostId: room.hostId, status: room.status,
      reconnectToken: player.reconnectToken,
      players: room.players.map(({ id, name, avatar }) => ({ id, name, avatar })),
      game: publicState(room, player.id), chat: room.chat
    })
  }
}
function error(socket, message) { socket.emit('game:error', message) }
function playerRoom(socket) { return socket.data.room && rooms.get(socket.data.room) }
function leave(socket, immediate = false) {
  const room = playerRoom(socket); if (!room) return
  const removedIndex = room.players.findIndex(player => player.id === socket.id)
  if (removedIndex < 0) return
  const removed = room.players[removedIndex]
  if (!immediate) {
    removed.disconnectTimer = setTimeout(() => {
      if (removed.id === socket.id) leave(socket, true)
    }, 30_000)
    return
  }
  room.players = room.players.filter(player => player.id !== socket.id)
  if (!room.players.length) rooms.delete(room.code)
  else {
    if (room.hostId === socket.id) room.hostId = room.players[0].id
    if (room.status === 'playing') {
      // If only 1 player left, end the game
      if (room.players.length < 2) {
        room.status = 'lobby'; room.game = null
        room.chat.unshift({ id: crypto.randomUUID(), name: 'VEIL', text: 'Not enough players — game ended.' })
      } else {
        // Adjust current index if needed so it still points to a valid player
        if (room.game) {
          if (removedIndex < room.game.current) room.game.current -= 1
          room.game.players = room.game.players.filter(p => p.id !== socket.id)
          if (room.game.current >= room.game.players.length) room.game.current = 0
          // If it was that player's turn, move to next
          room.game.log.unshift('A player left the table.')
        }
      }
    } else {
      room.chat.unshift({ id: crypto.randomUUID(), name: 'VEIL', text: 'A player left the lobby.' })
    }
    emitRoom(room)
  }
  socket.data.room = null
}

io.on('connection', socket => {
  socket.on('room:reconnect', ({ code, token } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase().trim())
    const player = room?.players.find(item => item.reconnectToken === token)
    if (!room || !player) return error(socket, 'Your previous table is no longer available.')
    clearTimeout(player.disconnectTimer)
    const previousId = player.id
    player.id = socket.id
    room.hostId = room.hostId === previousId ? socket.id : room.hostId
    room.game?.players.forEach(gamePlayer => { if (gamePlayer.id === previousId) gamePlayer.id = socket.id })
    if (room.game?.lastClaim?.playerId === previousId) room.game.lastClaim.playerId = socket.id
    socket.join(room.code); socket.data.room = room.code
    emitRoom(room)
  })

  socket.on('room:create', ({ name } = {}) => {
    const cleanName = String(name || '').trim().slice(0, 18)
    if (!cleanName) return error(socket, 'Choose a display name first.')
    const code = roomCode()
    const room = { code, hostId: socket.id, status: 'lobby', players: [{ id: socket.id, name: cleanName, avatar: avatars[0], reconnectToken: crypto.randomUUID() }], game: null, chat: [] }
    rooms.set(code, room); socket.join(code); socket.data.room = code; emitRoom(room)
  })

  socket.on('room:join', ({ code, name } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase().trim())
    const cleanName = String(name || '').trim().slice(0, 18)
    if (!room) return error(socket, 'That room code does not exist.')
    if (room.status !== 'lobby') return error(socket, 'This game has already started.')
    if (!cleanName) return error(socket, 'Choose a display name first.')
    if (room.players.length >= 8) return error(socket, 'This table is full (8 players max).')
    room.players.push({ id: socket.id, name: cleanName, avatar: avatars[room.players.length % avatars.length], reconnectToken: crypto.randomUUID() })
    socket.join(room.code); socket.data.room = room.code; emitRoom(room)
  })

  socket.on('room:start', () => {
    const room = playerRoom(socket)
    if (!room || room.hostId !== socket.id) return error(socket, 'Only the host can start this game.')
    if (room.players.length < 2) return error(socket, 'Invite at least one friend before starting.')
    room.status = 'playing'; room.game = newGame(room.players); emitRoom(room)
  })

  socket.on('game:play', ({ ids, rank } = {}) => {
    const room = playerRoom(socket); const game = room?.game
    if (!game || game.phase !== 'select' || game.players[game.current].id !== socket.id) return error(socket, 'It is not your turn.')
    if (!ranks.includes(rank) || !Array.isArray(ids) || !ids.length || ids.length > 4) return error(socket, 'Choose 1–4 cards and a valid claim.')
    const player = game.players[game.current]
    const chosen = player.hand.filter(card => ids.includes(card.id))
    if (chosen.length !== ids.length) return error(socket, 'One or more selected cards are not in your hand.')
    player.hand = player.hand.filter(card => !ids.includes(card.id))
    game.lastClaim = { playerId: player.id, rank, count: chosen.length, cards: chosen }
    game.current = next(game)
    game.phase = 'respond'
    game.log.unshift(`${player.name} placed ${chosen.length} card${chosen.length > 1 ? 's' : ''} and claims ${chosen.length} ${rank}${chosen.length > 1 ? 's' : ''}.`)
    emitRoom(room)
  })

  socket.on('game:respond', ({ callBluff } = {}) => {
    const room = playerRoom(socket); const game = room?.game; const claim = game?.lastClaim
    if (!game || !claim || game.phase !== 'respond' || game.players[game.current].id !== socket.id) return error(socket, 'It is not your decision.')
    let result = 'Claim accepted.'
    if (callBluff) {
      const truthful = claimIsTruthful(claim)
      const loser = truthful ? game.players[game.current] : game.players.find(player => player.id === claim.playerId)
      if (!loser) return error(socket, 'The challenged player is no longer at the table.')
      game.discard.push(...claim.cards)
      ensureDeck(game)
      const count = loser.shield ? 1 : 2
      loser.hand.push(...game.deck.splice(0, count))
      loser.shield = false
      result = truthful ? `${loser.name} challenged truth and draws ${count}.` : `${loser.name} was caught bluffing and draws ${count}.`
    } else {
      // Move the claimed cards to discard pile so deck can be reshuffled later
      game.discard.push(...claim.cards)
    }
    const winner = game.players.find(player => player.hand.length === 0)
    game.winner = winner?.id || null
    game.log.unshift(result)
    game.lastClaim = null
    game.phase = winner ? 'over' : 'select'
    // After respond, the current player (who just responded) now gets to play their cards
    // No turn advance — they already hold the turn pointer from game:play's next()
    game.round += 1
    emitRoom(room)
  })

  socket.on('game:skip', () => {
    const room = playerRoom(socket); const game = room?.game
    if (!game || game.phase !== 'select' || game.players[game.current].id !== socket.id) return error(socket, 'It is not your turn to skip.')
    const player = game.players[game.current]
    game.log.unshift(`${player.name} passed their turn.`)
    game.current = next(game)
    game.round += 1
    emitRoom(room)
  })

  socket.on('chat:send', message => {
    const room = playerRoom(socket); const player = room?.players.find(item => item.id === socket.id)
    const text = String(message || '').trim().slice(0, 180)
    if (!room || !player || !text) return
    room.chat.unshift({ id: crypto.randomUUID(), name: player.name, text })
    room.chat = room.chat.slice(0, 20); emitRoom(room)
  })

  socket.on('room:leave', () => leave(socket, true)); socket.on('disconnect', () => leave(socket))
})
httpServer.listen(process.env.PORT || 3001, () => console.log('VEIL multiplayer server listening on http://localhost:3001'))
