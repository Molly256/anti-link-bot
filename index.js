import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys'
import pino from 'pino'
import http from 'http'
import fs from 'fs'

const PORT = process.env.PORT || 3000
http.createServer((req,res)=>{res.writeHead(200);res.end('Bot active!')}).listen(PORT,'0.0.0.0',()=>console.log(`✅ Port ${PORT}`))

const PHONE_NUMBER = process.env.BOT_NUMBER || '256726168955'
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
let codeInterval = null

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

  // ✅ FIXED: New code every 25 seconds until you pair
  if(!sock.authState.creds.registered){
    const askCode = async()=>{
      try{
        const code = await sock.requestPairingCode(PHONE_NUMBER)
        console.log(`\n🔑 NEW CODE: ${code} - TYPE FAST!\n`)
      }catch(e){ console.log('code retry...') }
    }
    setTimeout(askCode, 6000)
    codeInterval = setInterval(askCode, 25000)
  }

  sock.ev.on('connection.update', async (u)=>{
    const { connection, lastDisconnect } = u
    if(connection === 'open'){
      console.log('✅ Bot online!')
      if(codeInterval) clearInterval(codeInterval)
      isStarting = false
    }
    if(connection === 'close'){
      const code = lastDisconnect?.error?.output?.statusCode
      console.log('Closed:', code)
      if(codeInterval) clearInterval(codeInterval)
      isStarting = false
      if(code === DisconnectReason.loggedOut){
        console.log('❌ Logged out - re-pair needed')
        try{ fs.rmSync('auth',{recursive:true,force:true}) }catch{}
        setTimeout(startBot, 5000)
        return
      }
      console.log('Reconnecting in 10s...')
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