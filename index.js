import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import pino from 'pino'
import http from 'http'

const PORT = process.env.PORT || 3000
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('Anti-Link Bot active!')
}).listen(PORT, '0.0.0.0', () => console.log(`✅ Port ${PORT}`))

const PHONE_NUMBER = process.env.BOT_NUMBER
const MAX_IMAGES_PER_DAY = 2

const warns = {}
const getToday = () => new Date().toISOString().split('T')[0]

function getUserData(groupId, userId) {
  if (!warns[groupId]) warns[groupId] = {}
  if (!warns[groupId][userId]) {
    warns[groupId][userId] = { linkWarns: 0, imageCount: 0, imageWarns: 0, date: getToday() }
  }
  if (warns[groupId][userId].date !== getToday()) {
    warns[groupId][userId].imageCount = 0
    warns[groupId][userId].imageWarns = 0
    warns[groupId][userId].date = getToday()
  }
  return warns[groupId][userId]
}

async function startBot() {
  const { version } = await fetchLatestBaileysVersion()
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    printQRInTerminal: false 
  })
  
  sock.ev.on('creds.update', saveCreds)
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      const code = await sock.requestPairingCode(PHONE_NUMBER)
      console.log(`\n🔑 CODE: ${code}\n`)
    }, 6000)
  }
  sock.ev.on('connection.update', async (u) => {
    if (u.connection === 'close') setTimeout(startBot, 5000)
    if (u.connection === 'open') console.log('✅ Bot online!')
  })

  sock.ev.on('messages.upsert', async (chatUpdate) => {
    for (const msg of chatUpdate.messages || []) {
      try {
        if (!msg.message || msg.key.fromMe) continue
        const from = msg.key.remoteJid
        if (!from?.endsWith('@g.us')) continue

        const sender = msg.key.participant
        if (!sender) continue

        const groupMetadata = await sock.groupMetadata(from)
        const participants = groupMetadata.participants
        const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net'
        const isSenderAdmin = participants.some(p => p.id === sender && p.admin)
        const isBotAdmin = participants.some(p => (p.id === botJid || p.id === sock.user.id) && p.admin)
        if (isSenderAdmin || !isBotAdmin) continue

        const userData = getUserData(from, sender)
        const mention = `@${sender.split('@')[0]}`
        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || ""

        // === LINK CHECK ===
        const linkRegex = /(https?:\/\/|www\.|chat\.whatsapp\.com|t\.me|wa\.me)/i
        if (linkRegex.test(body)) {
          await sock.sendMessage(from, { delete: msg.key })
          userData.linkWarns++

          if (userData.linkWarns === 1) {
            await sock.sendMessage(from, { text: `😡 ${mention} Links are NOT allowed!\n⚠️ Warning 1/3`, mentions: [sender] })
          } else if (userData.linkWarns === 2) {
            await sock.sendMessage(from, { text: `😡 ${mention} SECOND WARNING! One more link and you are OUT!\n⚠️ Warning 2/3`, mentions: [sender] })
          } else {
            await sock.sendMessage(from, { text: `🚫 ${mention} Removed for sending links 3 times!`, mentions: [sender] })
            await sock.groupParticipantsUpdate(from, [sender], 'remove')
            userData.linkWarns = 0
          }
          continue
        }

        // === IMAGE CHECK - ONLY 2 PER DAY ===
        if (msg.message.imageMessage) {
          userData.imageCount++
          
          if (userData.imageCount > MAX_IMAGES_PER_DAY) {
            await sock.sendMessage(from, { delete: msg.key })
            userData.imageWarns++

            if (userData.imageWarns === 1) {
              await sock.sendMessage(from, { text: `⚠️ ${mention} You already sent 2 images today! Only 2 images allowed per day.\nThis image deleted. Warning 1/2`, mentions: [sender] })
            } else if (userData.imageWarns === 2) {
              await sock.sendMessage(from, { text: `😡 ${mention} FINAL WARNING! You sent ${userData.imageCount} images today! Max is 2!\nNext image = KICK!\nWarning 2/2`, mentions: [sender] })
            } else {
              await sock.sendMessage(from, { text: `🚫 ${mention} Removed for spamming images! You sent ${userData.imageCount} images (max 2 per day)`, mentions: [sender] })
              await sock.groupParticipantsUpdate(from, [sender], 'remove')
              userData.imageCount = 0
              userData.imageWarns = 0
            }
          } else {
            console.log(`✅ Image ${userData.imageCount}/2 allowed from ${sender}`)
          }
        }

      } catch (e) { console.error(e) }
    }
  })
}
startBot()