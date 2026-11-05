import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import pino from 'pino'
import http from 'http'

// 1. RENDER HEALTH CHECK SERVER
const PORT = process.env.PORT || 3000
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('Anti-Link Bot is active and running!')
}).listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Web server successfully bound to port ${PORT}`)
})

// 2. RETRIEVE PHONE NUMBER FROM ENVIRONMENT
const PHONE_NUMBER = process.env.BOT_NUMBER 

async function startBot() {
  const { version } = await fetchLatestBaileysVersion()
  console.log('Using WA version', version)
  
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  
  const sock = makeWASocket.default({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    printQRInTerminal: false 
  })
  
  sock.ev.on('creds.update', saveCreds)
  
  // 3. WHATSAPP PAIRING CODE CONFIGURATION
  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER) {
      console.error('❌ CRITICAL ERROR: "BOT_NUMBER" environment variable is missing on Render!')
      process.exit(1)
    }
    
    setTimeout(async () => {
      try {
        console.log(`📲 Requesting pairing code for: ${PHONE_NUMBER}`)
        const code = await sock.requestPairingCode(PHONE_NUMBER)
        console.log(`\n========================================\n🔑 YOUR WHATSAPP PAIRING CODE: ${code}\n========================================\n`)
      } catch (err) {
        console.error('Failed to generate pairing code:', err)
      }
    }, 6000)
  }
  
  sock.ev.on('connection.update', async (u) => {
    if (u.connection === 'close') {
      console.log('Closed:', u.lastDisconnect?.error?.output?.statusCode, u.lastDisconnect?.error?.message)
      setTimeout(startBot, 5000)
    }
    if (u.connection === 'open') {
      console.log('✅ Bot online and securely connected to WhatsApp!')
    }
  })

  // 4. ANTI-LINK MONITORING LOGIC
  sock.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      const msg = chatUpdate.messages
      if (!msg || !msg.message || msg.key.fromMe) return 

      const from = msg.key.remoteJid
      if (!from.endsWith('@g.us')) return 

      const body = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || 
                   msg.message.imageMessage?.caption || 
                   msg.message.videoMessage?.caption || ''

      const linkRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi
      if (linkRegex.test(body)) {
        const sender = msg.key.participant || msg.key.participantOwner || msg.participant
        
        const groupMetadata = await sock.groupMetadata(from)
        const participants = groupMetadata.participants
        
        const botId = sock.user.id.split(':') + '@s.whatsapp.net'
        const isSenderAdmin = participants.some(p => p.id === sender && (p.admin === 'admin' || p.admin === 'superadmin'))
        const isBotAdmin = participants.some(p => p.id === botId && (p.admin === 'admin' || p.admin === 'superadmin'))

        if (!isSenderAdmin) {
          if (!isBotAdmin) {
            console.log(`⚠️ Link found in "${groupMetadata.subject}", but bot lacks admin rights.`)
            return
          }

          await sock.sendMessage(from, { delete: msg.key })
          await sock.groupParticipantsUpdate(from, [sender], 'remove')
          await sock.sendMessage(from, { 
            text: `🚫 @${sender.split('@')} has been removed automatically for link distribution.`, 
            mentions: [sender] 
          })
        }
      }
    } catch (err) {
      console.error('Anti-link runtime error:', err)
    }
  })
}

startBot()