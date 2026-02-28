const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const NODE_IP = '138.197.116.81';
const NET_PORT = 56001;
const TICKET_PRICE = 10;
const DRAW_INTERVAL = 5 * 60;
const EPOCH_START = 1740535200000;
const WINNER_SHARE = 0.95;
const TREASURY_SHARE = 0.05;
const LAMPORTS_PER_XRS = 1000000000;
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || '6G4GroMrVsGjd3xhywxfzXDg7vPn1V2Mky4B3qsXVGHo';
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '6G4GroMrVsGjd3xhywxfzXDg7vPn1V2Mky4B3qsXVGHo';

const S = { rounds: {}, winners: [] };

function getCurrentRound() {
  return Math.floor((Date.now() - EPOCH_START) / (DRAW_INTERVAL * 1000)) + 1;
}
function getRoundEnd(r) { return EPOCH_START + r * DRAW_INTERVAL * 1000; }
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
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = (Math.imul(h, 0x01000193)) >>> 0; }
  return h % max;
}
async function sendAirdrop(toAddress, amountXRS, reason) {
  const lamports = Math.floor(amountXRS * LAMPORTS_PER_XRS);
  const url = `http://${NODE_IP}:${NET_PORT}/airdrop/${toAddress}/${lamports}`;
  console.log(`[PAYOUT] ${amountXRS} XRS to ${toAddress.slice(0,8)}...`);
  try {
    const resp = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15000) });
    const text = await resp.text();
    console.log(`[PAYOUT] Response: ${text}`);
    return { ok: true, response: text };
  } catch(e) { console.log(`[PAYOUT] Error: ${e.message}`); return { ok: false, error: e.message }; }
}
async function executePayout(rd, w) {
  if (rd.payoutSent) return;
  rd.payoutSent = true;
  const r1 = await sendAirdrop(w.address, w.amount, `win-${w.round}`);
  if (w.treasury > 0) await sendAirdrop(TREASURY_ADDRESS, w.treasury, `treasury-${w.round}`);
  if (!r1.ok) rd.payoutSent = false;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Serve HTML
  if (req.url === '/' || req.url === '/public.html') {
    const html = fs.readFileSync(path.join(__dirname, 'public.html'), 'utf8');
    res.writeHead(200, {'Content-Type':'text/html','Cache-Control':'no-cache,no-store'});
    res.end(html); return;
  }

  // API
  if (req.url === '/api/state') {
    const round = getCurrentRound();
    const rd = getOrCreateRound(round);

    if (req.method === 'GET') {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, round, drawTarget:getRoundEnd(round), escrowAddress:ESCROW_ADDRESS, players:rd.players.map(p=>({address:p.address,tickets:p.tickets})), drawn:rd.drawn, winner:rd.winner, winners:S.winners.slice(0,20), serverTime:Date.now() }));
      return;
    }

    if (req.method === 'POST') {
      const body = await parseBody(req);
      const { action, address, tickets, txSig, round: clientRound } = body;

      if (action === 'join') {
        if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
          res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Invalid address'})); return;
        }
        const qty = parseInt(tickets,10);
        if (isNaN(qty)||qty<1||qty>100) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Invalid tickets'})); return; }
        if (rd.drawn) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Round drawn'})); return; }
        const ex = rd.players.find(p=>p.address===address);
        if (ex) { ex.tickets+=qty; } else { rd.players.push({address,tickets:qty,txSigs:txSig?[txSig]:[]}); }
        console.log(`[JOIN] Round #${round}: ${address.slice(0,8)}... +${qty} tickets`);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true,round,players:rd.players.map(p=>({address:p.address,tickets:p.tickets}))}));
        return;
      }

      if (action === 'draw') {
        const drawRound = parseInt(clientRound,10)||round;
        const drd = getOrCreateRound(drawRound);
        if (drd.drawn) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,alreadyDrawn:true,winner:drd.winner})); return; }
        if (!drd.players.length) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No players'})); return; }
        const total = drd.players.reduce((s,p)=>s+p.tickets,0);
        const seed = `round-${drawRound}-${drd.players.map(p=>`${p.address}:${p.tickets}`).join('|')}`;
        const roll = deterministicRoll(seed,total);
        let cum=0,winner=null;
        for(const p of drd.players){cum+=p.tickets;if(roll<cum){winner=p;break;}}
        if(!winner) winner=drd.players[drd.players.length-1];
        const totalPool=total*TICKET_PRICE;
        const winnerRecord={address:winner.address,amount:parseFloat((totalPool*WINNER_SHARE).toFixed(4)),treasury:parseFloat((totalPool*TREASURY_SHARE).toFixed(4)),totalPool,round:drawRound,drawnAt:Date.now(),payoutStatus:'pending'};
        drd.drawn=true; drd.winner=winnerRecord;
        S.winners.unshift(winnerRecord); if(S.winners.length>50) S.winners.length=50;
        executePayout(drd,winnerRecord).then(()=>{winnerRecord.payoutStatus='sent';}).catch(()=>{winnerRecord.payoutStatus='error';});
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true,winner:winnerRecord,round:drawRound}));
        return;
      }
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`xeris.fun running on port ${PORT}`));
