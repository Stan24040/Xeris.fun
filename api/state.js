// ═══════════════════════════════════════════════════════
//  XERIS.FUN — Shared Game State API  (Vercel serverless)
//  /api/state — single source of truth for all players
//
//  GET  /api/state         → current round, players, winners
//  POST /api/state {action:'join'}  → register a ticket purchase
//  POST /api/state {action:'draw'}  → trigger round draw
// ═══════════════════════════════════════════════════════

const TICKET_PRICE   = 10;
const DRAW_INTERVAL  = 5 * 60;       // seconds
const EPOCH_START    = 1740441600000; // Feb 25 2026 00:00:00 UTC
const WINNER_SHARE   = 0.95;
const TREASURY_SHARE = 0.05;
const MAX_TICKETS    = 100;

// ── In-memory shared state ──
// Persists across warm Vercel invocations (good enough for testnet)
const sharedState = {
  rounds:  {},   // { [roundNum]: RoundData }
  winners: [],   // last 50 winners across all rounds
};

function getCurrentRound() {
  return Math.floor((Date.now() - EPOCH_START) / (DRAW_INTERVAL * 1000)) + 1;
}
function getRoundEnd(round) {
  return EPOCH_START + round * DRAW_INTERVAL * 1000;
}

function getOrCreateRound(round) {
  if (!sharedState.rounds[round]) {
    sharedState.rounds[round] = {
      players: [],   // [{ address, tickets, txSigs[] }]
      drawTarget: getRoundEnd(round),
      drawn: false,
      winner: null,
    };
    // Prune old rounds — keep last 20
    const keys = Object.keys(sharedState.rounds).map(Number).sort((a, b) => b - a);
    keys.slice(20).forEach(k => delete sharedState.rounds[k]);
  }
  return sharedState.rounds[round];
}

// Deterministic integer hash — same seed → same number every time
function deterministicRoll(seed, max) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (Math.imul(h, 0x01000193)) >>> 0;
  }
  return h % max;
}

export default function handler(req, res) {
  // CORS — allow the Vercel frontend to call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const round     = getCurrentRound();
  const roundData = getOrCreateRound(round);

  // ── GET: return full shared game state ──
  if (req.method === 'GET') {
    return res.status(200).json({
      ok:         true,
      round,
      drawTarget: getRoundEnd(round),
      players:    roundData.players.map(p => ({
        address: p.address,
        tickets: p.tickets,
      })),
      drawn:      roundData.drawn,
      winner:     roundData.winner,
      winners:    sharedState.winners.slice(0, 20),
      serverTime: Date.now(),
    });
  }

  // ── POST: actions ──
  if (req.method === 'POST') {
    const body   = req.body || {};
    const action = body.action;

    // ── JOIN: register a confirmed ticket purchase ──
    if (action === 'join') {
      const { address, tickets, txSig } = body;

      // Validate
      if (!address || typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        return res.status(400).json({ ok: false, error: 'Invalid address' });
      }
      const qty = parseInt(tickets, 10);
      if (isNaN(qty) || qty < 1 || qty > MAX_TICKETS) {
        return res.status(400).json({ ok: false, error: 'Invalid ticket count' });
      }
      if (roundData.drawn) {
        return res.status(400).json({ ok: false, error: 'Round already drawn — wait for next round' });
      }

      // Deduplicate by txSig — prevent double-registering the same tx
      if (txSig) {
        const allSigs = roundData.players.flatMap(p => p.txSigs || []);
        if (allSigs.includes(txSig)) {
          return res.status(200).json({ ok: true, duplicate: true, players: roundData.players.map(p => ({ address: p.address, tickets: p.tickets })) });
        }
      }

      // Add or update player
      const existing = roundData.players.find(p => p.address === address);
      if (existing) {
        existing.tickets += qty;
        if (txSig) existing.txSigs = [...(existing.txSigs || []), txSig];
      } else {
        roundData.players.push({ address, tickets: qty, txSigs: txSig ? [txSig] : [] });
      }

      console.log(`[state] Round #${round} join: ${address.slice(0,8)}… +${qty} tickets. Total players: ${roundData.players.length}`);

      return res.status(200).json({
        ok: true,
        round,
        players: roundData.players.map(p => ({ address: p.address, tickets: p.tickets })),
      });
    }

    // ── DRAW: pick winner for completed round ──
    if (action === 'draw') {
      const clientRound = parseInt(body.round, 10) || round;

      // Allow drawing the just-completed round
      const drawRound = clientRound < round ? clientRound : round;
      const rd = getOrCreateRound(drawRound);

      if (rd.drawn) {
        return res.status(200).json({ ok: true, alreadyDrawn: true, winner: rd.winner, round: drawRound });
      }
      if (rd.players.length === 0) {
        return res.status(200).json({ ok: false, error: 'No players this round' });
      }

      // Pick winner deterministically
      const total = rd.players.reduce((s, p) => s + p.tickets, 0);
      const seed  = `round-${drawRound}-${rd.players.map(p => `${p.address}:${p.tickets}`).join('|')}`;
      const roll  = deterministicRoll(seed, total);

      let cum = 0, winner = null;
      for (const p of rd.players) {
        cum += p.tickets;
        if (roll < cum) { winner = p; break; }
      }
      if (!winner) winner = rd.players[rd.players.length - 1];

      const totalPool   = total * TICKET_PRICE;
      const winnerPrize = parseFloat((totalPool * WINNER_SHARE).toFixed(4));
      const treasuryCut = parseFloat((totalPool * TREASURY_SHARE).toFixed(4));

      const winnerRecord = {
        address:   winner.address,
        amount:    winnerPrize,
        treasury:  treasuryCut,
        totalPool,
        round:     drawRound,
        seed,
        drawnAt:   Date.now(),
      };

      rd.drawn  = true;
      rd.winner = winnerRecord;
      sharedState.winners.unshift(winnerRecord);
      if (sharedState.winners.length > 50) sharedState.winners.length = 50;

      console.log(`[state] Round #${drawRound} drawn! Winner: ${winner.address.slice(0,8)}… — ${winnerPrize} XRS`);

      return res.status(200).json({ ok: true, winner: winnerRecord, round: drawRound });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  }

  res.status(405).end();
}
