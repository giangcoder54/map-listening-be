import type { Response, Router } from 'express'
import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { settleSepayTransaction } from '../lib/sepay'


const SIGNATURE_TOLERANCE_SECONDS = 300

function verifyHmacSignature(req: any, secret: string, logger: any): boolean {
  const signatureHeader = String(req.headers['x-sepay-signature'] || '')
  const timestampHeader = String(req.headers['x-sepay-timestamp'] || '')

  if (!signatureHeader || !timestampHeader) {
    logger.warn('[SePay] Thiếu header X-SePay-Signature hoặc X-SePay-Timestamp')
    return false
  }

  const rawBody: Buffer | undefined = req.rawBody
  if (!rawBody) {
    logger.error('[SePay] Không có rawBody — cần thêm hook giữ raw body trước khi dùng HMAC. Tạm dùng SEPAY_API_TOKEN (API Key) thay thế.')
    return false
  }

  const timestamp = Number(timestampHeader)
  const skewSeconds = Math.abs(Date.now() / 1000 - timestamp)
  if (!Number.isFinite(skewSeconds) || skewSeconds > SIGNATURE_TOLERANCE_SECONDS) {
    logger.warn(`[SePay] Timestamp lệch ${Math.round(skewSeconds)}s (cho phép ${SIGNATURE_TOLERANCE_SECONDS}s)`)
    return false
  }

  const signedPayload = Buffer.concat([Buffer.from(`${timestampHeader}.`, 'utf8'), rawBody])
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex')
  const received = signatureHeader.replace(/^sha256=/i, '')

  const expectedBuf = Buffer.from(expected, 'utf8')
  const receivedBuf = Buffer.from(received, 'utf8')
  if (expectedBuf.length !== receivedBuf.length) {
    logger.warn('[SePay] Chữ ký sai độ dài')
    return false
  }
  if (!timingSafeEqual(expectedBuf, receivedBuf)) {
    logger.warn('[SePay] Chữ ký HMAC không khớp')
    return false
  }

  return true
}

/**
 * Chọn phương thức xác thực theo env, fail-closed:
 *   - có SEPAY_WEBHOOK_SECRET  → bắt buộc HMAC-SHA256 (cần hook raw body, xem trên)
 *   - chỉ có SEPAY_API_TOKEN → API Key (`Authorization: Apikey <key>`), dùng được ngay
 *   - không có gì              → từ chối tất cả
 */
function isAuthentic(req: any, logger: any): boolean {
  const secret = process.env.SEPAY_WEBHOOK_SECRET
  if (secret)
    return verifyHmacSignature(req, secret, logger)

  const apiKey = process.env.SEPAY_API_TOKEN
  if (apiKey) {
    if (req.headers.authorization === `Apikey ${apiKey}`)
      return true
    logger.warn('[SePay] API Key không đúng')
    return false
  }

  logger.error('[SePay] Chưa cấu hình SEPAY_WEBHOOK_SECRET hoặc SEPAY_API_TOKEN — từ chối webhook')
  return false
}

export function handleSepayWebhook(router: Router, context: any) {
  const { logger } = context

  router.post('/sepay-webhook', async (req: any, res: Response) => {
    if (!isAuthentic(req, logger))
      return res.status(401).json({ success: false })

    const payload = req.body || {}
    logger.info(`[SePay] Webhook: ${JSON.stringify(payload)}`)

    if (payload.transferType && payload.transferType !== 'in')
      return res.status(200).json({ success: true })

    try {
      const result = await settleSepayTransaction(
        {
          id: payload.id,
          content: payload.content,
          code: payload.code,
          amountIn: Number(payload.transferAmount || 0),
          referenceCode: payload.referenceCode,
        },
        context,
      )

      if (result !== 'activated')
        logger.info(`[SePay] Giao dịch ${payload.id}: ${result}`)

      return res.status(200).json({ success: true })
    }
    catch (error: any) {
      logger.error(`[SePay] Lỗi xử lý webhook ${payload.id}: ${String(error?.stack || error)}`)
      return res.status(500).json({ success: false })
    }
  })
}
