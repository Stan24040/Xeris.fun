const http = require('http');
const fs = require('fs');
const path = require('path');
const bs58 = require('bs58');
const nacl = require('tweetnacl');

const PORT = process.env.PORT || 3000;
const NODE_IP = '138.197.116.81';
const RPC_PORT = 50008;
const NET_PORT = 56001;
const TICKET_PRICE = 10;
const DRAW_INTERVAL = 5 * 60 * 1000;
const EPOCH_START = 1740535200000;
const WINNER_SHARE = 0.95;
const TREASURY_SHARE = 0.05;
const LAMPORTS_PER_XRS = 1_000_000_000;

const ESCROW_ADDRESS   = process.env.ESCROW_ADDRESS   || '';
const ESCROW_PRIVKEY   = process.env.ESCROW_PRIVATE_KEY || '';
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '';

const S = { rounds: {}, winners: [], verifiedTx: new Set() };

function getCurrentRound() { return Math.floor((Date.now()-EPOCH_START)/DRAW_INTERVAL)+1; }
function getRoundEnd(r)    { return EPOCH_START + r*DRAW_INTERVAL; }
function getOrCreateRound(r) {
  if (!S.rounds[r]) S.rounds[r] = { players:[], drawn:false, winner:null, payoutSent:false };
  const keys = Object.keys(S.rounds).map(Number).sort((a,b)=>b-a);
  keys.slice(20).forEach(k=>delete S.rounds[k]);
  return S.rounds[r];
}
function deterministicRoll(seed, max) {
  let h=0x811c9dc5;
  for(let i=0;i<seed.length;i++){h^=seed.charCodeAt(i);h=(Math.imul(h,0x01000193))>>>0;}
  return h%max;
}

// ── Verify TX: check escrow balance increased by expected amount ──
async function getEscrowLamports() {
  const resp = await fetch(`http://${NODE_IP}:${RPC_PORT}`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getAccountInfo',params:[ESCROW_ADDRESS,{encoding:'base64'}]}),
    signal: AbortSignal.timeout(8000)
  });
  const data = await resp.json();
  return parseInt(data?.result?.value?.lamports || 0);
}

async function verifyTransaction(txSig, fromAddress, expectedLamports) {
  if (S.verifiedTx.has(txSig)) return {ok:false, error:'Transaction already used'};
  try {
    // Get current escrow balance
    const currentLamports = await getEscrowLamports();
    console.log(`[VERIFY] Escrow lamports: ${currentLamports}, prev: ${S.escrowBalance||0}, expected delta: ${expectedLamports}`);

    // Initialize baseline on first run
    if (!S.escrowBalance) { S.escrowBalance = currentLamports; }

    const received = currentLamports - S.escrowBalance;
    console.log(`[VERIFY] Balance delta: +${received} lamports, need: ${expectedLamports}`);

    if (received >= Math.floor(expectedLamports * 0.99)) {
      S.escrowBalance = currentLamports;
      S.verifiedTx.add(txSig);
      console.log(`[VERIFY] ✓ Payment confirmed! ${received} lamports received`);
      return {ok:true, received};
    }

    // Also try getTransaction as fallback
    const txResp = await fetch(`http://${NODE_IP}:${RPC_PORT}`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getTransaction',params:[txSig,{encoding:'jsonParsed'}]}),
      signal: AbortSignal.timeout(8000)
    });
    const txData = await txResp.json();
    if (txData.result && txData.result !== null) {
      S.escrowBalance = currentLamports;
      S.verifiedTx.add(txSig);
      console.log(`[VERIFY] ✓ TX found on chain`);
      return {ok:true};
    }

    return {ok:false, error:`Payment not detected yet. Escrow received ${received} lamports, need ${expectedLamports}. Wait a moment and try again.`};
  } catch(e) {
    console.log('[VERIFY] Error:', e.message);
    return {ok:false, error:'Verification error: '+e.message};
  }
}
  try {
    const url = `http://${NODE_IP}:${RPC_PORT}`;
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getTransaction',
      params: [txSig, {encoding:'json'}]
    });
    const resp = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body,
      signal: AbortSignal.timeout(10000)
    });
    const data = await resp.json();
    console.log('[VERIFY] TX response:', JSON.stringify(data).slice(0,300));

    if (!data.result) return { ok:false, error:'Transaction not found on chain' };

    const tx = data.result;
    // Check it's not already used
    if (S.verifiedTx.has(txSig)) return { ok:false, error:'Transaction already used' };

    // Check recipient is escrow and amount matches
    const meta = tx.meta || tx.transaction?.message;
    const instructions = tx.transaction?.message?.instructions || tx.instructions || [];
    
    // Look for transfer to escrow address with correct amount
    let verified = false;
    for (const ix of instructions) {
      if (ix.parsed?.type === 'transfer' || ix.type === 'transfer') {
        const info = ix.parsed?.info || ix.info || {};
        const dest = info.destination || info.to || '';
        const amt  = parseInt(info.lamports || info.amount || 0);
        console.log(`[VERIFY] ix dest=${dest} amt=${amt} expected escrow=${ESCROW_ADDRESS} expectedAmt=${expectedLamports}`);
        if (dest === ESCROW_ADDRESS && amt >= expectedLamports * 0.99) {
          verified = true; break;
        }
      }
    }

    // Fallback: check account balance changes
    if (!verified && tx.meta) {
      const preBalances  = tx.meta.preBalances  || [];
      const postBalances = tx.meta.postBalances || [];
      const accounts     = tx.transaction?.message?.accountKeys || [];
      for (let i=0; i<accounts.length; i++) {
        const addr = typeof accounts[i]==='string' ? accounts[i] : accounts[i]?.pubkey;
        if (addr === ESCROW_ADDRESS) {
          const received = (postBalances[i]||0) - (preBalances[i]||0);
          console.log(`[VERIFY] Escrow balance change: +${received} lamports`);
          if (received >= expectedLamports * 0.99) { verified = true; break; }
        }
      }
    }

    if (!verified) return { ok:false, error:'Payment amount or destination mismatch' };
    S.verifiedTx.add(txSig);
    return { ok:true };
  } catch(e) {
    console.log('[VERIFY] Error:', e.message);
    return { ok:false, error:'Could not verify: '+e.message };
  }
}

// ── Send signed payout from escrow wallet ──
async function sendSignedPayout(toAddress, amountXRS, reason) {
  const lamports = Math.floor(amountXRS * LAMPORTS_PER_XRS);
  console.log(`[PAYOUT] Sending ${amountXRS} XRS to ${toAddress.slice(0,8)}...`);

  // Try airdrop endpoint first (testnet)
  try {
    const url = `http://${NODE_IP}:${NET_PORT}/airdrop/${toAddress}/${lamports}`;
    const resp = await fetch(url, {method:'POST', signal:AbortSignal.timeout(15000)});
    const text = await resp.text();
    console.log(`[PAYOUT] Airdrop response: ${text}`);
    if (resp.ok || text.toLowerCase().includes('sent') || text.toLowerCase().includes('success')) {
      return { ok:true, method:'airdrop', response:text };
    }
  } catch(e) { console.log('[PAYOUT] Airdrop failed:', e.message); }

  // Fallback: signed transaction from escrow wallet
  if (!ESCROW_PRIVKEY) return { ok:false, error:'No escrow private key configured' };
  try {
    const secretKey = bs58.decode(ESCROW_PRIVKEY);
    const keypair   = nacl.sign.keyPair.fromSecretKey(secretKey);

    // Get blockhash
    const bhResp = await fetch(`http://${NODE_IP}:${RPC_PORT}`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getLatestBlockhash',params:[]}),
      signal: AbortSignal.timeout(10000)
    });
    const bhData = await bhResp.json();
    const blockhash = bhData.result?.value?.blockhash || bhData.result?.blockhash;
    if (!blockhash) throw new Error('No blockhash');

    // Build and sign transaction
    const txPayload = {
      recentBlockhash: blockhash,
      feePayer: ESCROW_ADDRESS,
      instructions: [{
        programId: '11111111111111111111111111111111',
        type: 'transfer',
        keys: [
          {pubkey: ESCROW_ADDRESS, isSigner:true, isWritable:true},
          {pubkey: toAddress,      isSigner:false, isWritable:true}
        ],
        data: {instruction:2, lamports}
      }]
    };
    const message = Buffer.from(JSON.stringify(txPayload));
    const signature = nacl.sign.detached(message, keypair.secretKey);
    const sigBase58 = bs58.encode(signature);
    const txBase64 = Buffer.from(JSON.stringify({...txPayload, signature:sigBase58})).toString('base64');

    const sendResp = await fetch(`http://${NODE_IP}:${RPC_PORT}`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method:'sendTransaction',params:[txBase64]}),
      signal: AbortSignal.timeout(15000)
    });
    const sendData = await sendResp.json();
    console.log('[PAYOUT] Signed tx response:', JSON.stringify(sendData));
    return { ok:true, method:'signed', txid: sendData.result };
  } catch(e) {
    console.log('[PAYOUT] Signed tx error:', e.message);
    return { ok:false, error:e.message };
  }
}

async function executePayout(rd, w) {
  if (rd.payoutSent) return;
  rd.payoutSent = true;
  const r1 = await sendSignedPayout(w.address, w.amount, `win-${w.round}`);
  if (w.treasury>0 && TREASURY_ADDRESS) await sendSignedPayout(TREASURY_ADDRESS, w.treasury, `treasury-${w.round}`);
  if (!r1.ok) rd.payoutSent = false;
  return r1;
}

function parseBody(req) {
  return new Promise(resolve => {
    let b=''; req.on('data',d=>b+=d); req.on('end',()=>{ try{resolve(JSON.parse(b));}catch{resolve({});} });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS'){res.writeHead(200);res.end();return;}

  if (req.url==='/'||req.url==='/index.html'||req.url==='/public.html') {
    const html = fs.readFileSync(path.join(__dirname,'public.html'),'utf8');
    res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-cache,no-store,must-revalidate'});
    res.end(html); return;
  }

  if (req.url==='/api/state') {
    const round = getCurrentRound();
    const rd = getOrCreateRound(round);

    if (req.method==='GET') {
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,round,drawTarget:getRoundEnd(round),escrowAddress:ESCROW_ADDRESS,
        players:rd.players.map(p=>({address:p.address,tickets:p.tickets,username:p.username||''})),
        drawn:rd.drawn,winner:rd.winner,winners:S.winners.slice(0,20),serverTime:Date.now()}));
      return;
    }

    if (req.method==='POST') {
      const {action,address,tickets,txSig,username,round:clientRound} = await parseBody(req);

      if (action==='join') {
        if (!address||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'Invalid wallet address'})); return;
        }
        const qty = parseInt(tickets,10);
        if (isNaN(qty)||qty<1||qty>100) {
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'Invalid ticket count'})); return;
        }
        if (rd.drawn) {
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'Round already drawn'})); return;
        }
        if (!txSig||txSig.length<32) {
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'Transaction signature required'})); return;
        }

        // Verify TX on chain
        const expectedLamports = qty * TICKET_PRICE * LAMPORTS_PER_XRS;
        console.log(`[JOIN] Verifying TX ${txSig} from ${address.slice(0,8)}...`);
        const verify = await verifyTransaction(txSig, address, expectedLamports);
        if (!verify.ok) {
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'Payment not verified: '+verify.error})); return;
        }

        const ex = rd.players.find(p=>p.address===address);
        if (ex) { ex.tickets+=qty; ex.username=username||ex.username; }
        else rd.players.push({address,tickets:qty,username:username||''});
        console.log(`[JOIN] ✓ Round #${round}: ${username||address.slice(0,8)} +${qty} tickets`);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true,round,players:rd.players.map(p=>({address:p.address,tickets:p.tickets,username:p.username}))}));
        return;
      }

      if (action==='draw') {
        const drawRound = parseInt(clientRound,10)||round;
        const drd = getOrCreateRound(drawRound);
        if (drd.drawn) {
          if (drd.winner&&!drd.payoutSent) executePayout(drd,drd.winner).catch(console.error);
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true,alreadyDrawn:true,winner:drd.winner})); return;
        }
        if (!drd.players.length) {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'No players'})); return;
        }
        const total = drd.players.reduce((s,p)=>s+p.tickets,0);
        const seed = `round-${drawRound}-${drd.players.map(p=>`${p.address}:${p.tickets}`).join('|')}`;
        const roll = deterministicRoll(seed,total);
        let cum=0,winner=null;
        for(const p of drd.players){cum+=p.tickets;if(roll<cum){winner=p;break;}}
        if(!winner) winner=drd.players[drd.players.length-1];
        const totalPool=total*TICKET_PRICE;
        const winnerRecord={
          address:winner.address,username:winner.username||'',
          amount:parseFloat((totalPool*WINNER_SHARE).toFixed(4)),
          treasury:parseFloat((totalPool*TREASURY_SHARE).toFixed(4)),
          totalPool,round:drawRound,drawnAt:Date.now(),payoutStatus:'pending'
        };
        drd.drawn=true; drd.winner=winnerRecord;
        S.winners.unshift(winnerRecord);
        if(S.winners.length>50) S.winners.length=50;
        executePayout(drd,winnerRecord).then(r=>{winnerRecord.payoutStatus=r?.ok?'sent':'failed';}).catch(()=>{});
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true,winner:winnerRecord,round:drawRound})); return;
      }
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT,()=>console.log(`xeris.fun v9.2 on port ${PORT}`));
