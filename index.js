import makeWASocket, { useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'

// FIXED: no more .com alone - was deleting "welcome"
const LINK_REGEX = /(https?:\/\/|www\.|t\.me\/|wa\.me\/|chat\.whatsapp\.com|youtube\.com|youtu\.be|telegram\.me)/i

let antiLinkGroups = new Set()
let warnings = {}
let photoCount = {}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ["AntiLink Bot", "Chrome", "1.0"]
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if(qr){
      console.log('\n\n==== SCAN THIS QR WITH YOUR WHATSAPP ====')
      qrcode.generate(qr, { small: true })
      console.log('=========================================\n\n')
    }
    if(connection === 'close'){
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log('Connection closed, code:', statusCode, 'reconnect:', shouldReconnect)
      if(shouldReconnect) {
        setTimeout(() => startBot(), 2000)
      } else {
        console.log('Logged out, delete auth folder')
      }
    }
    if(connection === 'open'){
      console.log('✅ Bot is online! Add it to your group as ADMIN then type !antilink on')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for(const msg of messages){
      try{
        if(!msg.message || msg.key.fromMe) continue
        const jid = msg.key.remoteJid
        if(!jid || !jid.endsWith('@g.us')) continue

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || ''
        const hasImage = !!msg.message.imageMessage
        const hasVideo = !!msg.message.videoMessage
        const hasLink = LINK_REGEX.test(text)

        if(text.toLowerCase().trim() === '!antilink on' || text.toLowerCase().trim() === '/antilink on'){
          antiLinkGroups.add(jid)
          await sock.sendMessage(jid, { text: '✅ Anti-Link Bot Activated\n\n📌 Rules:\n• Text: Unlimited ✅\n• Photos: Max 2 ✅\n• Links: Not allowed ❌\n• Videos: Count as media\n\n⚠️ Warn 2 times, 3rd = Kick' })
          continue
        }
        if(text.toLowerCase().trim() === '!antilink off'){
          antiLinkGroups.delete(jid)
          await sock.sendMessage(jid, { text: '❌ Anti-Link OFF' })
          continue
        }
        if(text.toLowerCase().trim() === '!resetphotos' || text.toLowerCase().trim() === '!reset'){
          Object.keys(photoCount).forEach(k => { if(k.startsWith(jid)) delete photoCount[k] })
          Object.keys(warnings).forEach(k => { if(k.startsWith(jid)) delete warnings[k] })
          await sock.sendMessage(jid, { text: '🔄 Photo count & warnings reset' })
          continue
        }

        if(!antiLinkGroups.has(jid)) continue

        let groupMeta
        try { groupMeta = await sock.groupMetadata(jid) } catch { continue }
        const sender = msg.key.participant
        if(!sender) continue
        const senderInfo = groupMeta.participants.find(p => p.id === sender)
        const isAdmin = senderInfo?.admin === 'admin' || senderInfo?.admin === 'superadmin'
        if(isAdmin) continue

        const key = `${jid}_${sender}`
        let shouldDelete = false
        let reason = ''

        if(hasLink){
          shouldDelete = true
          reason = 'sending links'
        }

        if(hasImage || hasVideo){
          photoCount[key] = (photoCount[key] || 0) + 1
          if(photoCount[key] > 2){
            shouldDelete = true
            reason = `more than 2 photos/videos (${photoCount[key]})`
          }
        }

        if(shouldDelete){
          try { await sock.sendMessage(jid, { delete: msg.key }) } catch {}
          
          warnings[key] = (warnings[key] || 0) + 1
          const warnCount = warnings[key]

          if(warnCount < 3){
            await sock.sendMessage(jid, { 
              text: `⚠️ @${sender.split('@')[0]} Warning ${warnCount}/3\nReason: ${reason}\nMedia: ${photoCount[key]||0}/2`,
              mentions: [sender]
            })
          } else {
            await sock.sendMessage(jid, { 
              text: `🚫 @${sender.split('@')[0]} Removed! Reason: ${reason} (3 warnings)`,
              mentions: [sender]
            })
            await new Promise(r => setTimeout(r, 1000))
            try { await sock.groupParticipantsUpdate(jid, [sender], 'remove') } catch {}
            delete warnings[key]
            delete photoCount[key]
          }
        }
      }catch(e){
        console.log('Error:', e.message)
      }
    }
  })
}

startBot()