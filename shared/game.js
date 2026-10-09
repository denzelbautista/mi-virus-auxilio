// Pure, authoritative rules. Imported by the server and by the client for previews.
export const COLORS = ['red', 'green', 'blue', 'yellow', 'wild'];
export const COLOR_NAMES = { red: 'Rojo', green: 'Verde', blue: 'Azul', yellow: 'Amarillo', wild: 'Multicolor', purple: 'Tratamiento' };
export const ORGAN_NAMES = { red: 'Corazón', green: 'Estómago', blue: 'Cerebro', yellow: 'Hueso', wild: 'Órgano multicolor' };
export const SPECIAL_NAMES = { transplant: 'Trasplante', thief: 'Ladrón de órganos', contagion: 'Contagio', glove: 'Guante de látex', error: 'Error médico' };
export function cardName(c) { return c.type === 'organ' ? ORGAN_NAMES[c.color] : c.type === 'special' ? SPECIAL_NAMES[c.special] : `${c.type === 'virus' ? 'Virus' : 'Medicina'} ${c.type === 'medicine' && c.color === 'red' ? 'roja' : c.type === 'medicine' && c.color === 'yellow' ? 'amarilla' : COLOR_NAMES[c.color].toLowerCase()}`; }
export const MAX_PLAYERS = 8;
export function createDeck(playerCount = 4) {
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > MAX_PLAYERS) throw new Error('Elige entre 2 y 8 jugadores.');
  // Preserve equal counts across the basic colors and round each original group.
  const scale = Math.max(1, playerCount / 4);
  const copies = count => Math.round(count * scale);
  let id = 0; const deck = [];
  for (const color of COLORS) for (const [type, count] of [['organ', color === 'wild' ? 1 : 5], ['virus', color === 'wild' ? 1 : 4], ['medicine', 4]]) {
    for (let n = 0; n < copies(count); n++) deck.push({ id: `c${++id}`, type, color });
  }
  for (const [special, count] of [['transplant', 1], ['thief', 3], ['contagion', 2], ['glove', 3], ['error', 1]]) {
    for (let n = 0; n < copies(count); n++) deck.push({ id: `c${++id}`, type: 'special', color: 'purple', special });
  }
  return deck;
}
export const deckSizeFor = playerCount => createDeck(playerCount).length;
export function shuffle(cards, random = Math.random) { for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; } return cards; }
export function matches(a, b) { return a.color === 'wild' || b.color === 'wild' || a.color === b.color; }
export function status(o) { return o.attachments.some(c => c.type === 'virus') ? 'infected' : o.attachments.length >= 2 ? 'immune' : o.attachments.length === 1 ? 'vaccinated' : 'healthy'; }
export function healthyCount(p) { return p.body.filter(o => status(o) !== 'infected').length; }
export function draw(g, p) {
  while (p.hand.length < 3) {
    if (!g.deck.length) g.deck = g.discard.splice(0).reverse(); // Turn over, do not reshuffle.
    if (!g.deck.length) break;
    p.hand.push(g.deck.pop());
  }
}
export function newGame(players, random = Math.random) {
  const deck = createDeck(players.length);
  const g = { players: players.map(p => ({ ...p, hand: [], body: [], skip: false })), deck: shuffle(deck, random), deckSize: deck.length, startingPlayerCount: players.length, discard: [], turn: 0, round: 1, winnerId: null, lastEvent: null, sequence: 0 };
  for (const p of g.players) draw(g, p);
  return g;
}
function canReceive(p, organ, outgoingId) { return !p.body.some(o => o.card.id !== outgoingId && o.card.color === organ.card.color); }
export function contagionPlan(g, actor) {
  const sources = actor.body.filter(o => status(o) === 'infected');
  const targets = g.players.filter(p => p.id !== actor.id).flatMap(p => p.body.filter(o => status(o) === 'healthy').map(o => ({ p, o })));
  // Maximum bipartite matching avoids enumerating every assignment across
  // seven rival bodies while still allowing any maximum plan from the client.
  const assigned = new Map();
  function assign(sourceIndex, visited) {
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
      if (visited.has(targetIndex) || !matches(sources[sourceIndex].attachments[0], targets[targetIndex].o.card)) continue;
      visited.add(targetIndex);
      const previous = assigned.get(targetIndex);
      if (previous === undefined || assign(previous, visited)) { assigned.set(targetIndex, sourceIndex); return true; }
    }
    return false;
  }
  sources.forEach((_, index) => assign(index, new Set()));
  return [...assigned].map(([targetIndex, sourceIndex]) => ({ sourceOrganId: sources[sourceIndex].card.id, targetPlayerId: targets[targetIndex].p.id, targetOrganId: targets[targetIndex].o.card.id }));
}
export function legalActions(g, playerId) {
  if (g.winnerId || g.abandoned) return [];
  const actor = g.players[g.turn]; if (!actor || actor.id !== playerId || actor.skip) return [];
  const result = [];
  const add = (card, fields = {}) => { const a = { cardId: card.id, ...fields }; a.key = [card.id, fields.targetPlayerId || '', fields.targetOrganId || '', fields.otherPlayerId || '', fields.otherOrganId || ''].join(':'); result.push(a); };
  for (const card of actor.hand) {
    if (card.type === 'organ') { if (canReceive(actor, { card })) add(card, { targetPlayerId: actor.id }); continue; }
    if (card.type !== 'special') {
      for (const p of g.players) for (const o of p.body) {
        const s = status(o); if (s === 'immune') continue;
        const affected = card.type === 'medicine' && s === 'infected' || card.type === 'virus' && s === 'vaccinated' ? o.attachments[0] : o.card;
        if (matches(card, affected)) add(card, { targetPlayerId: p.id, targetOrganId: o.card.id });
      }
      continue;
    }
    if (card.special === 'glove') add(card);
    if (card.special === 'error') for (const p of g.players) if (p.id !== actor.id) add(card, { targetPlayerId: p.id });
    if (card.special === 'thief') for (const p of g.players) if (p.id !== actor.id) for (const o of p.body) if (status(o) !== 'immune' && canReceive(actor, o)) add(card, { targetPlayerId: p.id, targetOrganId: o.card.id });
    if (card.special === 'transplant') {
      for (let i = 0; i < g.players.length; i++) for (let j = i + 1; j < g.players.length; j++) {
        const p = g.players[i], q = g.players[j];
        for (const o of p.body) for (const other of q.body) if (status(o) !== 'immune' && status(other) !== 'immune' && canReceive(p, other, o.card.id) && canReceive(q, o, other.card.id)) {
          add(card, { targetPlayerId: p.id, targetOrganId: o.card.id, otherPlayerId: q.id, otherOrganId: other.card.id });
        }
      }
    }
    if (card.special === 'contagion') { const moves = contagionPlan(g, actor); if (moves.length) add(card, { moves }); }
  }
  return result;
}
export function validateContagion(g, actor, moves) {
  if (!Array.isArray(moves) || moves.length !== contagionPlan(g, actor).length || !moves.length) return false;
  const sources = new Set(), targets = new Set();
  return moves.every(m => {
    if (!m || sources.has(m.sourceOrganId) || targets.has(m.targetOrganId)) return false;
    const o = actor.body.find(o => o.card.id === m.sourceOrganId);
    const p = g.players.find(p => p.id === m.targetPlayerId && p.id !== actor.id);
    const target = p?.body.find(o => o.card.id === m.targetOrganId);
    if (!o || !target || status(o) !== 'infected' || status(target) !== 'healthy' || !matches(o.attachments[0], target.card)) return false;
    sources.add(m.sourceOrganId); targets.add(m.targetOrganId); return true;
  });
}
export function act(g, playerId, request) {
  if (g.winnerId) throw new Error('La partida ya terminó.');
  const actor = g.players[g.turn]; if (actor.id !== playerId) throw new Error('Espera tu turno.');
  if (actor.skip) throw new Error('Debes reponer tu mano.');
  if (request.type === 'discard') {
    const ids = request.cardIds;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || !ids.every(id => actor.hand.some(c => c.id === id))) throw new Error('Selecciona entre una y tres cartas de tu mano.');
    const cards = actor.hand.filter(c => ids.includes(c.id)); actor.hand = actor.hand.filter(c => !ids.includes(c.id)); g.discard.push(...cards);
    event(g, { actorId: actor.id, text: `${actor.name} descartó ${cards.length} carta${cards.length > 1 ? 's' : ''}.`, card: cards.at(-1), discard: true });
  } else if (request.type === 'play') {
    const action = legalActions(g, playerId).find(a => a.key === request.key);
    if (!action) throw new Error('Esa jugada no es válida. Elige un destino resaltado.');
    const card = actor.hand.find(c => c.id === action.cardId);
    if (request.moves !== undefined && (card.special !== 'contagion' || !validateContagion(g, actor, request.moves))) throw new Error('Contagio debe trasladar el máximo posible de virus a órganos libres compatibles.');
    const p = g.players.find(p => p.id === action.targetPlayerId);
    const o = p?.body.find(o => o.card.id === action.targetOrganId);
    actor.hand.splice(actor.hand.indexOf(card), 1);
    let effect = '';
    if (card.type === 'organ') { actor.body.push({ card, attachments: [] }); effect = 'incorporó'; }
    else if (card.type === 'virus') {
      const s = status(o);
      if (s === 'vaccinated') { g.discard.push(...o.attachments.splice(0), card); effect = 'eliminó la vacuna de'; }
      else if (s === 'infected') { p.body.splice(p.body.indexOf(o), 1); g.discard.push(o.card, ...o.attachments, card); effect = 'extirpó'; }
      else { o.attachments.push(card); effect = 'infectó'; }
    } else if (card.type === 'medicine') {
      if (status(o) === 'infected') { g.discard.push(...o.attachments.splice(0), card); effect = 'curó'; }
      else { o.attachments.push(card); effect = status(o) === 'immune' ? 'inmunizó' : 'vacunó'; }
    } else {
      g.discard.push(card);
      if (card.special === 'thief') { p.body.splice(p.body.indexOf(o), 1); actor.body.push(o); }
      if (card.special === 'error') [actor.body, p.body] = [p.body, actor.body];
      if (card.special === 'transplant') {
        const q = g.players.find(p => p.id === action.otherPlayerId), other = q.body.find(o => o.card.id === action.otherOrganId);
        const a = p.body.indexOf(o), b = q.body.indexOf(other); p.body[a] = other; q.body[b] = o;
      }
      if (card.special === 'glove') for (const q of g.players) if (q.id !== actor.id) { g.discard.push(...q.hand.splice(0)); q.skip = true; }
      if (card.special === 'contagion') for (const m of request.moves || action.moves) {
        const source = actor.body.find(o => o.card.id === m.sourceOrganId);
        const q = g.players.find(p => p.id === m.targetPlayerId), target = q.body.find(o => o.card.id === m.targetOrganId);
        target.attachments.push(...source.attachments.splice(0));
      }
    }
    event(g, { actorId: actor.id, card, targetPlayerId: action.targetPlayerId, targetOrganId: action.targetOrganId, special: card.special, text: card.type === 'special' ? `${actor.name} usó ${cardName(card)}.` : `${actor.name} ${effect} ${cardName(o?.card || card)}${p && p.id !== actor.id ? ` de ${p.name}` : ''}.` });
  } else throw new Error('Acción desconocida.');
  draw(g, actor);
  checkWinner(g, actor.id);
  if (!g.winnerId) { g.turn = (g.turn + 1) % g.players.length; if (g.turn === 0) g.round++; }
  return g.lastEvent;
}
function event(g, e) { g.lastEvent = { ...e, sequence: ++g.sequence }; }
function checkWinner(g, preferredId) {
  // Treatments can give another player a complete body. Actor wins ties.
  const ordered = [g.players.find(p => p.id === preferredId), ...g.players.filter(p => p.id !== preferredId)];
  const winner = ordered.find(p => healthyCount(p) >= 4); if (winner) g.winnerId = winner.id;
}
export function eliminatePlayers(g, playerIds, random = Math.random, reason = { kind: 'disconnect' }) {
  if (g.winnerId || g.abandoned) return [];
  const ids = new Set(playerIds), previous = g.players.slice(), currentIndex = g.turn;
  const removed = previous.filter(p => ids.has(p.id));
  if (!removed.length) return [];
  const returned = removed.flatMap(p => [...p.hand, ...p.body.flatMap(o => [o.card, ...o.attachments])]);
  g.deck.push(...returned); shuffle(g.deck, random);
  g.players = previous.filter(p => !ids.has(p.id));
  const next = Array.from({ length: previous.length }, (_,i) => previous[(currentIndex + i) % previous.length]).find(p => !ids.has(p.id));
  g.turn = next ? g.players.findIndex(p => p.id === next.id) : 0;
  if (next && ids.has(previous[currentIndex].id) && previous.indexOf(next) < currentIndex) g.round++;
  if (g.players.length === 1) { g.winnerId = g.players[0].id; g.winnerReason = 'abandonment'; }
  if (!g.players.length) g.abandoned = true;
  event(g, { kind: 'elimination', reason: reason.kind, actorId: removed[0].id, eliminatedPlayerIds: removed.map(p => p.id), returnedCount: returned.length,
    text: `${removed.map(p => p.name).join(', ')} ${removed.length === 1 ? 'queda eliminado' : 'quedan eliminados'} ${reason.kind === 'autopilot' ? `tras ${reason.turns || 15} turnos en piloto automático` : 'tras cinco minutos de ausencia'}.${g.winnerId ? ` ${g.players[0].name} gana por abandono.` : g.abandoned ? ' La partida terminó sin jugadores.' : ` Sus ${returned.length} cartas vuelven al mazo.`}` });
  return removed;
}
export function refillTurn(g) {
  const p = g.players[g.turn]; if (!p.skip || g.winnerId) throw new Error('No hay un turno de reposición pendiente.');
  p.skip = false; draw(g, p); event(g, { actorId: p.id, text: `${p.name} repuso su mano y perdió el turno por el guante de látex.` });
  g.turn = (g.turn + 1) % g.players.length; if (g.turn === 0) g.round++;
}
export function publicGame(g, playerId) {
  return { deckSize: g.deckSize ?? g.deck.length + g.discard.length + g.players.reduce((total, p) => total + p.hand.length + p.body.reduce((n, o) => n + 1 + o.attachments.length, 0), 0), startingPlayerCount: g.startingPlayerCount ?? g.players.length, players: g.players.map(p => ({ id: p.id, name: p.name, bot: !!p.bot, body: p.body, handCount: p.hand.length, skip: p.skip, healthy: healthyCount(p) })), hand: g.players.find(p => p.id === playerId)?.hand || [], deckCount: g.deck.length, discardCount: g.discard.length, discardTop: g.discard.at(-1) || null, discardPreview: g.discard.slice(-6), turnPlayerId: g.players[g.turn]?.id || null, round: g.round, winnerId: g.winnerId, winnerReason: g.winnerReason || null, lastEvent: g.lastEvent, actions: legalActions(g, playerId) };
}
