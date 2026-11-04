import baileysPkg from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import http from 'http'

const makeWASocket = baileysPkg.default || baileysPkg.makeWASocket
const { useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = baileysPkg

// Render needs a port or it kills you
http.createServer((req,res)=>res.end('Bot is running')).listen(process.env.PORT || 3000)

const LINK_REGEX = /(https?:\/\/|www\.|t\.me\/|wa\.me\/|chat\.whatsapp\.com|youtube\.com|youtu\.be|telegram\.me)/i
let antiLinkGroups = new Set()
let warnings = {}
let photoCount = {}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
    logger: pino({ level: 'silent' }),
    browser: ["AntiLink Bot", "Chrome", "1.0"]
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    if(qr){
      console.log('\nSCAN THIS QR IN RENDER LOGS:')
      qrcode.generate(qr, { small: true })
    }
    if(connection === 'close'){
      const code = lastDisconnect?.error?.output?.statusCode
      console.log('Closed code:', code)
      if(code !== DisconnectReason.loggedOut){
        setTimeout(() => startBot(), 3000)
      }else{
        console.log('LOGGED OUT - delete auth folder')
      }
    }
    if(connection === 'open') console.log('✅ Bot online!')
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for(const msg of messages){
      try{
        if(!msg.message || msg.key.fromMe) continue
        const jid = msg.key.remoteJid
        if(!jid?.endsWith('@g.us')) continue
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || ''
        const hasImage = !!msg.message.imageMessage
        const hasVideo = !!msg.message.videoMessage
        const hasLink = LINK_REGEX.test(text)
        const low = text.toLowerCase().trim()
        if(low === '!antilink on' || low === '/antilink on'){ antiLinkGroups.add(jid); await sock.sendMessage(jid, { text: '✅ Anti-Link ON' }); continue }
        if(low === '!antilink off'){ antiLinkGroups.delete(jid); await sock.sendMessage(jid, { text: '❌ OFF' }); continue }
        if(low === '!reset' || low === '!resetphotos'){ Object.keys(photoCount).forEach(k=>{if(k.startsWith(jid)) delete photoCount[k]}); Object.keys(warnings).forEach(k=>{if(k.startsWith(jid)) delete warnings[k]}); await sock.sendMessage(jid, { text: '🔄 Reset' }); continue }
        if(!antiLinkGroups.has(jid)) continue
        let meta; try{ meta = await sock.groupMetadata(jid) }catch{ continue }
        const sender = msg.key.participant; if(!sender) continue
        const p = meta.participants.find(x=>x.id===sender)
        if(p?.admin) continue
        const key = `${jid}_${sender}`
        let del=false; let reason=''
        if(hasLink){ del=true; reason='links' }
        if(hasImage||hasVideo){ photoCount[key]=(photoCount[key]||0)+1; if(photoCount[key]>2){ del=true; reason=`>2 media (${photoCount[key]})` } }
        if(del){
          try{ await sock.sendMessage(jid, { delete: msg.key }) }catch{}
          warnings[key]=(warnings[key]||0)+1
          if(warnings[key]<3){ await sock.sendMessage(jid, { text: `⚠️ @${sender.split('@')[0]} Warn ${warnings[key]}/3 ${reason}`, mentions:[sender] }) }
          else{ await sock.sendMessage(jid, { text: `🚫 @${sender.split('@')[0]} Kicked ${reason}`, mentions:[sender] }); await new Promise(r=>setTimeout(r,1000)); try{ await sock.groupParticipantsUpdate(jid,[sender],'remove') }catch{}; delete warnings[key]; delete photoCount[key] }
        }
      }catch(e){ console.log(e.message) }
    }
  })
}
startBot()