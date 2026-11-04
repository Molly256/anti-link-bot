const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const fs = require('fs')
const http = require('http')

http.createServer((req,res)=>res.end('Bot running')).listen(process.env.PORT||3000)

async function startBot(){
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({level:'silent'})) },
    logger: pino({level:'silent'}),
    browser: ['Chrome','Chrome','1.0']
  })
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async (u)=>{
    if(u.qr){ console.log('\n\n=== SCAN QR BELOW ===\n'); qrcode.generate(u.qr, {small:true}) }
    if(u.connection==='close'){
      const code = u.lastDisconnect?.error?.output?.statusCode
      console.log('Closed:', code)
      if(code===405 || code===DisconnectReason.loggedOut){
        fs.rmSync('auth', {recursive:true, force:true})
        console.log('Deleted bad auth, restarting...')
      }
      setTimeout(startBot, 2000)
    }
    if(u.connection==='open') console.log('✅ Bot online!')
  })

  sock.ev.on('messages.upsert', async ({messages})=>{
    for(const msg of messages){
      if(!msg.message || msg.key.fromMe) continue
      const jid = msg.key.remoteJid
      if(!jid.endsWith('@g.us')) continue
      const txt = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
      if(txt.toLowerCase()==='!antilink on'){ global.antilink=true; await sock.sendMessage(jid,{text:'✅ ON'}) }
    }
  })
}
startBot()