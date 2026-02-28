const NODE_IP          = '138.197.116.81';
const NET_PORT         = 56001;
const TICKET_PRICE     = 10;
const DRAW_INTERVAL    = 5 * 60;
const EPOCH_START      = 1740535200000;
const WINNER_SHARE     = 0.95;
const TREASURY_SHARE   = 0.05;
const MAX_TICKETS      = 100;
const LAMPORTS_PER_XRS = 1000000000;

const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '6G4GroMrVsGjd3xhywxfzXDg7vPn1V2Mky4B3qsXVGHo';
const ESCROW_ADDRESS   = process.env.ESCROW_ADDRESS   || '6G4GroMrVsGjd3xhywxfzXDg7vPn1V2Mky4B3qsXVGHo';

const S = { rounds: {}, winners: [] };

function getCurrentRound() {
  return Math.floor((Date.now() - EPOCH_START) / (DRAW_INTERVAL * 1000)) + 1;
}
function getRoundEnd(r) {
  return EPOCH_START + r * DRAW_INTERVAL * 1000;
}
function getOrCreateRound(r) {
  if (!S.rounds[r]) {
    S.rounds[r] = { players: [], drawn: false, winner: null, payoutSent: false };
    const keys = Object.keys(S.rounds).map(Number).sort((a,b)=>b-a);
    keys.slice(20).forEach(k => delete S.rounds[k]);
  }
  return S.rounds[r];
}
function deterministicRoll(seed, max) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (Math.imul(h, 0x01000193)) >>> 0;
  }
  return h % max;
}

async function sendAirdrop(toAddress, amountXRS, reason) {
  const lamports = Math.floor(amountXRS * LAMPORTS_PER_XRS);
  const url = `http://${NODE_IP}:${NET_PORT}/airdrop/${toAddress}/${lamports}`;
  console.log(`[PAYOUT] Airdropping ${amountXRS} XRS to ${toAddress.slice(0,8)}... reason=${reason}`);
  try {
    const resp = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15000) });
    const text = await resp.text();
    console.log(`[PAYOUT] Response: ${text}`);
    return { ok: true, method: 'airdrop', response: text };
  } catch (e) {
    console.log(`[PAYOUT] Error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function executePayout(rd, w) {
  if (rd.payoutSent) return { ok: true, alreadySent: true };
  rd.payoutSent = true;
  const r1 = await sendAirdrop(w.address, w.amount, `win-round-${w.round}`);
  const r2 = w.treasury > 0
    ? await sendAirdrop(TREASURY_ADDRESS, w.treasury, `treasury-round-${w.round}`)
    : { ok: true };
  if (!r1.ok) rd.payoutSent = false;
  return { winner: r1, treasury: r2 };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const round = getCurrentRound();
  const rd    = getOrCreateRound(round);

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true, round,
      drawTarget:    getRoundEnd(round),
      escrowAddress: ESCROW_ADDRESS,
      players:       rd.players.map(p => ({ address: p.address, tickets: p.tickets })),
      drawn:         rd.drawn,
      winner:        rd.winner,
      winners:       S.winners.slice(0, 20),
      serverTime:    Date.now(),
    });
  }

  if (req.method === 'POST') {
    const { action, address, tickets, txSig, round: clientRound } = req.body || {};

    if (action === 'join') {
      if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
        return res.status(400).json({ ok: false, error: 'Invalid address' });
      const qty = parseInt(tickets, 10);
      if (isNaN(qty) || qty < 1 || qty > MAX_TICKETS)
        return res.status(400).json({ ok: false, error: 'Invalid ticket count' });
      if (rd.drawn)
        return res.status(400).json({ ok: false, error: 'Round drawn - wait for next' });
      if (txSig) {
        const allSigs = rd.players.flatMap(p => p.txSigs || []);
        if (allSigs.includes(txSig))
          return res.status(200).json({ ok: true, duplicate: true });
      }
      const ex = rd.players.find(p => p.address === address);
      if (ex) {
        ex.tickets += qty;
        if (txSig) ex.txSigs = [...(ex.txSigs||[]), txSig];
      } else {
        rd.players.push({ address, tickets: qty, txSigs: txSig ? [txSig] : [] });
      }
      console.log(`[JOIN] Round #${round}: ${address.slice(0,8)}... +${qty} tickets`);
      return res.status(200).json({
        ok: true, round,
        players: rd.players.map(p => ({ address: p.address, tickets: p.tickets })),
      });
    }

    if (action === 'draw') {
      const drawRound = parseInt(clientRound,10) || round;
      const drd = getOrCreateRound(drawRound);
      if (drd.drawn) {
        if (drd.winner && !drd.payoutSent) executePayout(drd, drd.winner).catch(console.error);
        return res.status(200).json({ ok: true, alreadyDrawn: true, winner: drd.winner, round: drawRound });
      }
      if (!drd.players.length)
        return res.status(200).json({ ok: false, error: 'No players this round' });

      const total = drd.players.reduce((s,p) => s+p.tickets, 0);
      const seed  = `round-${drawRound}-${drd.players.map(p=>`${p.address}:${p.tickets}`).join('|')}`;
      const roll  = deterministicRoll(seed, total);
      let cum=0, winner=null;
      for (const p of drd.players) { cum+=p.tickets; if(roll<cum){winner=p;break;} }
      if (!winner) winner = drd.players[drd.players.length-1];

      const totalPool   = total * TICKET_PRICE;
      const winnerPrize = parseFloat((totalPool * WINNER_SHARE).toFixed(4));
      const treasuryCut = parseFloat((totalPool * TREASURY_SHARE).toFixed(4));

      const winnerRecord = {
        address: winner.address, amount: winnerPrize, treasury: treasuryCut,
        totalPool, tickets: winner.tickets, totalTickets: total,
        round: drawRound, seed, drawnAt: Date.now(), payoutStatus: 'pending',
      };

      drd.drawn=true; drd.winner=winnerRecord;
      S.winners.unshift(winnerRecord);
      if (S.winners.length>50) S.winners.length=50;

      console.log(`[DRAW] Round #${drawRound} winner: ${winner.address.slice(0,8)}... ${winnerPrize} XRS`);

      executePayout(drd, winnerRecord)
        .then(r => { winnerRecord.payoutStatus = r.winner?.ok ? 'sent' : 'failed'; })
        .catch(e => { winnerRecord.payoutStatus = 'error'; });

      return res.status(200).json({ ok: true, winner: winnerRecord, round: drawRound });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  }
  res.status(405).end();
}
