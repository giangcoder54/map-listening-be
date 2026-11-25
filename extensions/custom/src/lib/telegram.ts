/**
 * Admin notifications to a Telegram group.
 * Needs TELEGRAM_BOT_TOKEN and TELEGRAM_GROUP_ID. Never throws: a failed message must not
 * break a payment or a request. Failures go to the log (without the token).
 */
let warnedMissing = false

export async function notifyAdmin(message: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_GROUP_ID
  if (!token || !chatId) {
    if (!warnedMissing)
      console.warn('[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_GROUP_ID is not set: admin messages are not sent')
    warnedMissing = true
    return false
  }
  // The connection to Telegram sometimes times out, so a network error gets two more tries
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Telegram rejects messages over 4096 characters
        body: JSON.stringify({ chat_id: chatId, text: message.slice(0, 4096) }),
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok)
        return true
      // Telegram answered and refused (wrong token, wrong group...): trying again will not help
      console.warn(`[telegram] send failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
      return false
    }
    catch (error: any) {
      console.warn(`[telegram] send failed (try ${attempt}/3): ${String(error?.cause?.code || error?.message || error)}`)
      if (attempt < 3)
        await new Promise(resolve => setTimeout(resolve, attempt * 2000))
    }
  }
  return false
}
