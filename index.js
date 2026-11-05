import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys'
import pino from 'pino'
import http from 'http'
import fs from 'fs'
import QRCode from 'qrcode'

const PORT = process.env.PORT || 3000
let lastQR = null

http.createServer(async (req,res)=>{
  if(lastQR){
    const qrImage = await QRCode.toDataURL(lastQR)
    res.writeHead(200, {'Content-Type':'text/html'})
    res.end(`<h1>Scan this with your 256 phone</h1><img src="${qrImage}" style="width:300px"><p>Refresh if expired</p>`)
  } else {
    res.writeHead(200); res.end('Bot starting... waiting for QR, refresh in 5 sec')
  }
}).listen(PORT,'0.0.0.0',()=>console.log(`✅ Port ${PORT}`))

const MAX_IMAGES_PER_DAY = 2
const warns = {}
const getToday = () => new Date().toISOString().split('T')[0]
function getUserData(g,u){
  if(!warns[g]) warns[g]={}
  if(!warns[g][u]) warns[g][u]={linkWarns:0,imageCount:0,imageWarns:0,date:getToday()}
  if(warns[g][u].date!==getToday()){warns[g][u].imageCount=0;warns[g][u].imageWarns=0;warns[g][u].date=getToday()}
  return warns[g][u]
}

let isStarting = false

async function startBot(){
  if(isStarting) return
  isStarting = true

  const { version } = await fetchLatestBaileysVersion()
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({level:'silent'})) },
    logger: pino({level:'silent'}),
    browser: ['Ubuntu','Chrome','20.0.04'],
    printQRInTerminal: false,
    syncFullHistory: false
  })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u)=>{
    const { connection, lastDisconnect, qr } = u
    if(qr){
      lastQR = qr
      console.log('📱 NEW QR - open your Render URL to scan!')
    }
    if(connection === 'open'){
      console.log('✅ Bot online! ✅')
      lastQR = null
      isStarting = false
    }
    if(connection === 'close'){
      const code = lastDisconnect?.error?.output?.statusCode
      console.log('Closed:', code)
      isStarting = false
      if(code === DisconnectReason.loggedOut){
        try{ fs.rmSync('auth',{recursive:true,force:true}) }catch{}
        setTimeout(startBot, 5000)
        return
      }
      setTimeout(startBot, 10000)
    }
  })

  sock.ev.on('messages.upsert', async (chatUpdate)=>{
    for(const msg of chatUpdate.messages || []){
      try{
        if(!msg.message || msg.key.fromMe) continue
        const from = msg.key.remoteJid
        if(!from?.endsWith('@g.us')) continue
        const sender = msg.key.participant || msg.key.participantAlt
        if(!sender) continue
        const groupMetadata = await sock.groupMetadata(from)
        const participants = groupMetadata.participants
        const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net'
        const isSenderAdmin = participants.some(p=>p.id===sender && p.admin)
        const isBotAdmin = participants.some(p=>(p.id===botJid || p.id===sock.user.id) && p.admin)
        if(isSenderAdmin || !isBotAdmin) continue

        const userData = getUserData(from, sender)
        const mention = `@${sender.split('@')[0]}`
        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || ""

        const linkRegex = /(https?:\/\/|www\.|chat\.whatsapp\.com|t\.me|wa\.me)/i
        if(linkRegex.test(body)){
          await sock.sendMessage(from, { delete: msg.key })
          userData.linkWarns++
          if(userData.linkWarns===1) await sock.sendMessage(from,{text:`😡 ${mention} Links NOT allowed!\n⚠️ Warning 1/3`,mentions:[sender]})
          else if(userData.linkWarns===2) await sock.sendMessage(from,{text:`😡 ${mention} SECOND WARNING! One more = OUT!\n⚠️ Warning 2/3`,mentions:[sender]})
          else { await sock.sendMessage(from,{text:`🚫 ${mention} Removed for links 3x!`,mentions:[sender]}); await sock.groupParticipantsUpdate(from,[sender],'remove'); userData.linkWarns=0 }
          continue
        }

        if(msg.message.imageMessage){
          userData.imageCount++
          if(userData.imageCount > MAX_IMAGES_PER_DAY){
            await sock.sendMessage(from, { delete: msg.key })
            userData.imageWarns++
            if(userData.imageWarns===1) await sock.sendMessage(from,{text:`⚠️ ${mention} Only 2 images per day! Warning 1/2`,mentions:[sender]})
            else if(userData.imageWarns===2) await sock.sendMessage(from,{text:`😡 ${mention} FINAL WARNING for images! Warning 2/2`,mentions:[sender]})
            else { await sock.sendMessage(from,{text:`🚫 ${mention} Removed for image spam!`,mentions:[sender]}); await sock.groupParticipantsUpdate(from,[sender],'remove'); userData.imageCount=0; userData.imageWarns=0 }
          }
        }
      }catch(e){console.error(e)}
    }
  })
}
startBot()