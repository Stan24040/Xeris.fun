const http = require('http');
const fs = require('fs');
const path = require('path');
const bs58 = require('bs58');
const nacl = require('tweetnacl');
const bip39 = require('bip39');

const PORT = process.env.PORT || 3000;
const NODE_IP = '138.197.116.81';
const RPC_PORT = 50008;
const NET_PORT = 56001;
const TICKET_PRICE = 10;
const DRAW_INTERVAL = 10 * 60 * 1000;
const EPOCH_START = 1740535200000;
const WINNER_SHARE = 0.95;
const TREASURY_SHARE = 0.05;
const LAMPORTS_PER_XRS = 1_000_000_000;

const ESCROW_ADDRESS   = process.env.ESCROW_ADDRESS   || '';
const ESCROW_PRIVKEY   = process.env.ESCROW_PRIVATE_KEY || '';
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '';

const S = { rounds:{}, winners:[], verifiedTx: new Set(), escrowLamports: 0 };

function getCurrentRound(){ return Math.floor((Date.now()-EPOCH_START)/DRAW_INTERVAL)+1; }
function getRoundEnd(r){ return EPOCH_START + r*DRAW_INTERVAL; }
function getOrCreateRound(r){
  if(!S.rounds[r]) S.rounds[r]={players:[],drawn:false,winner:null,payoutSent:false};
  const keys=Object.keys(S.rounds).map(Number).sort((a,b)=>b-a);
  keys.slice(20).forEach(k=>delete S.rounds[k]);
  return S.rounds[r];
}
function deterministicRoll(seed,max){
  let h=0x811c9dc5;
  for(let i=0;i<seed.length;i++){h^=seed.charCodeAt(i);h=(Math.imul(h,0x01000193))>>>0;}
  return h%max;
}


function getEscrowKeypair(){
  if(!ESCROW_SEED_PHRASE){ console.log('[KP] No seed phrase set'); return null; }
  try {
    const seed = bip39.mnemonicToSeedSync(ESCROW_SEED_PHRASE).slice(0,32);
    return nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
  } catch(e){ console.log('[KP] Error:',e.message); return null; }
}

async function buildAndSendTransfer(kp, toAddress, lamports){
  const bhRes = await fetch('http://'+NODE_IP+':'+RPC_PORT,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getRecentBlockhash',params:[]})
  });
  const bhData = await bhRes.json();
  const blockhash = bhData.result && bhData.result.value && bhData.result.value.blockhash;
  if(!blockhash) throw new Error('No blockhash from RPC');

  const from = kp.publicKey;
  const to = bs58.decode(toAddress);
  const prog = new Uint8Array(32);

  const idata = new Uint8Array(12);
  idata[0]=2;
  const dv = new DataView(idata.buffer);
  dv.setBigUint64(4, BigInt(lamports), true);

  function cu16(n){ return n<128?[n]:[n&0x7f|0x80,n>>7]; }

  const bh = bs58.decode(blockhash);
  const parts = [
    new Uint8Array([1,0,1]),
    new Uint8Array(cu16(3)),
    from, to, prog, bh,
    new Uint8Array(cu16(1)),
    new Uint8Array([2]),
    new Uint8Array(cu16(2)),
    new Uint8Array([0,1]),
    new Uint8Array(cu16(idata.length)),
    idata
  ];
  const len = parts.reduce((s,p)=>s+p.length,0);
  const msg = new Uint8Array(len);
  let off=0; parts.forEach(p=>{msg.set(p,off);off+=p.length;});

  const sig = nacl.sign.detached(msg, kp.secretKey);
  const tx = new Uint8Array(1+64+len);
  tx[0]=1; tx.set(sig,1); tx.set(msg,65);

  const txb58 = bs58.encode(tx);
  const rpc = await fetch('http://'+NODE_IP+':'+RPC_PORT,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'sendTransaction',params:[txb58,{encoding:'base58'}]}),
    signal:AbortSignal.timeout(20000)
  });
  const rd = await rpc.json();
  if(rd.error) throw new Error(rd.error.message||JSON.stringify(rd.error));
  return rd.result;
}

async function getEscrowLamports(){
  try {
    const r = await fetch(`http://${NODE_IP}:${RPC_PORT}`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getAccountInfo',params:[ESCROW_ADDRESS,{encoding:'base64'}]}),
      signal:AbortSignal.timeout(8000)
    });
    const d = await r.json();
    return parseInt(d?.result?.value?.lamports||0);
  } catch(e){ console.log('[BAL] Error:',e.message); return 0; }
}

async function verifyPayment(txSig, expectedLamports){
  if(S.verifiedTx.has(txSig)) return {ok:false,error:'Transaction already used'};
  try {
    const current = await getEscrowLamports();
    console.log(`[VERIFY] Escrow: ${current}, prev: ${S.escrowLamports}, need: ${expectedLamports}`);
    if(S.escrowLamports===0) S.escrowLamports = current;
    const delta = current - S.escrowLamports;
    if(delta >= Math.floor(expectedLamports*0.99)){
      S.escrowLamports = current;
      S.verifiedTx.add(txSig);
      console.log(`[VERIFY] ✓ +${delta} lamports confirmed`);
      return {ok:true};
    }
    return {ok:false, error:`Payment not detected. Escrow received ${delta} lamports, need ${expectedLamports}. Send XRS then wait 10 seconds.`};
  } catch(e){
    return {ok:false, error:'Verification failed: '+e.message};
  }
}

// Initialize escrow balance on startup
if(ESCROW_ADDRESS) getEscrowLamports().then(b=>{ S.escrowLamports=b; console.log(`[INIT] Escrow balance: ${b} lamports`); });

async function sendPayout(toAddress, amountXRS){
  const lamports = Math.floor(amountXRS * LAMPORTS_PER_XRS);
  console.log(`[PAYOUT] Sending ${amountXRS} XRS (${lamports} lamps) to ${toAddress.slice(0,8)}...`);
  try {
    const kp = getEscrowKeypair();
    if(!kp) throw new Error('Set ESCROW_SEED_PHRASE in Railway env vars');
    const txid = await buildAndSendTransfer(kp, toAddress, lamports);
    console.log('[PAYOUT] txid:', txid);
    return {ok:true, txid};
  } catch(e){
    console.log(`[PAYOUT] Error: ${e.message}`);
    return {ok:false, error:e.message};
  }
}

async function executePayout(rd, w){
  if(rd.payoutSent) return;
  rd.payoutSent = true;
  const r1 = await sendPayout(w.address, w.amount);
  if(TREASURY_ADDRESS && w.treasury>0) await sendPayout(TREASURY_ADDRESS, w.treasury);
  if(!r1.ok) rd.payoutSent = false;
  return r1;
}

function parseBody(req){
  return new Promise(resolve=>{
    let b=''; req.on('data',d=>b+=d); req.on('end',()=>{ try{resolve(JSON.parse(b));}catch{resolve({});} });
  });
}

const server = http.createServer(async (req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}

  const url = req.url.split('?')[0];

  if(url==='/'||url==='/index.html'||url==='/public.html'){
    try {
      const html = fs.readFileSync(path.join(__dirname,'public.html'),'utf8');
      res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-cache,no-store'});
      res.end(html);
    } catch(e){ res.writeHead(500); res.end('Error: '+e.message); }
    return;
  }

  if(url==='/api/state'){
    const round = getCurrentRound();
    const rd = getOrCreateRound(round);

    if(req.method==='GET'){
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({
        ok:true, round, drawTarget:getRoundEnd(round),
        escrowAddress:ESCROW_ADDRESS,
        players:rd.players.map(p=>({address:p.address,tickets:p.tickets,username:p.username||''})),
        drawn:rd.drawn, winner:rd.winner,
        winners:S.winners.slice(0,20), serverTime:Date.now()
      }));
      return;
    }

    if(req.method==='POST'){
      const body = await parseBody(req);
      const {action,address,tickets,txSig,username,round:clientRound} = body;

      if(action==='join'){
        if(!address||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)){
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'Invalid wallet address'})); return;
        }
        const qty = parseInt(tickets,10);
        if(isNaN(qty)||qty<1||qty>100){
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'Invalid ticket count'})); return;
        }
        if(rd.drawn){
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'Round already drawn - wait for next'})); return;
        }
        if(!txSig||txSig.length<32){
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'Paste your transaction ID from Xeris wallet'})); return;
        }

        const expectedLamports = qty * TICKET_PRICE * LAMPORTS_PER_XRS;
        const verify = await verifyPayment(txSig, expectedLamports);
        if(!verify.ok){
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:verify.error})); return;
        }

        const ex = rd.players.find(p=>p.address===address);
        if(ex){ ex.tickets+=qty; ex.username=username||ex.username; }
        else rd.players.push({address,tickets:qty,username:username||''});
        console.log(`[JOIN] ✓ Round #${round}: ${username||address.slice(0,8)} +${qty} tickets`);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true,round,players:rd.players.map(p=>({address:p.address,tickets:p.tickets,username:p.username}))}));
        return;
      }

      if(action==='draw'){
        const drawRound = parseInt(clientRound,10)||round;
        const drd = getOrCreateRound(drawRound);
        if(drd.drawn){
          if(drd.winner&&!drd.payoutSent) executePayout(drd,drd.winner).catch(console.error);
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true,alreadyDrawn:true,winner:drd.winner})); return;
        }
        if(!drd.players.length){
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'No players this round'})); return;
        }
        const total = drd.players.reduce((s,p)=>s+p.tickets,0);
        const seed = `round-${drawRound}-${drd.players.map(p=>`${p.address}:${p.tickets}`).join('|')}`;
        const roll = deterministicRoll(seed,total);
        let cum=0,winner=null;
        for(const p of drd.players){cum+=p.tickets;if(roll<cum){winner=p;break;}}
        if(!winner) winner=drd.players[drd.players.length-1];
        const totalPool = total*TICKET_PRICE;
        const winnerRecord = {
          address:winner.address, username:winner.username||'',
          amount:parseFloat((totalPool*WINNER_SHARE).toFixed(4)),
          treasury:parseFloat((totalPool*TREASURY_SHARE).toFixed(4)),
          totalPool, round:drawRound, drawnAt:Date.now(), payoutStatus:'pending'
        };
        drd.drawn=true; drd.winner=winnerRecord;
        S.winners.unshift(winnerRecord);
        if(S.winners.length>50) S.winners.length=50;
        console.log(`[DRAW] Round #${drawRound} winner: ${winner.username||winner.address.slice(0,8)} — ${winnerRecord.amount} XRS`);
        executePayout(drd,winnerRecord).then(r=>{winnerRecord.payoutStatus=r?.ok?'sent':'failed';}).catch(()=>{});
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true,winner:winnerRecord,round:drawRound})); return;
      }
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT,()=>console.log(`xeris.fun v9.3 on port ${PORT}`));
