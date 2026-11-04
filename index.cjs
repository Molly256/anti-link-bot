const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const http = require('http')

http.createServer((req,res)=>res.end('Bot running')).listen(process.env.PORT||3000)

async function startBot(){
  const { version } = await fetchLatestBaileysVersion()
  console.log('Using WA version', version)
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({level:'silent'})) },
    logger: pino({level:'silent'}),
    browser: ['Chrome','Chrome','120.0.0'],
    printQRInTerminal: true
  })
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async (u)=>{
    if(u.qr){ console.log('\n\n=== SCAN QR NOW ===\n'); qrcode.generate(u.qr, {small:true}) }
    if(u.connection==='close'){
      console.log('Closed:', u.lastDisconnect?.error?.output?.statusCode, u.lastDisconnect?.error?.message)
      setTimeout(startBot, 3000)
    }
    if(u.connection==='open') console.log('✅ Bot online!')
  })
}
startBot()