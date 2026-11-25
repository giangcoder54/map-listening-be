import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Polar (polar.sh) — Merchant of Record cho khách quốc tế trả bằng thẻ (USD).
 * Khách Việt Nam vẫn đi luồng VietQR/SePay như cũ.
 *
 * Env (đặt trong .env của Directus):
 *   POLAR_SERVER            sandbox | production   (mặc định sandbox — an toàn khi quên đặt)
 *   POLAR_ACCESS_TOKEN      Organization Access Token (Settings → Developers)
 *   POLAR_WEBHOOK_SECRET    secret của webhook endpoint (Settings → Webhooks)
 *   POLAR_PRODUCT_MONTHLY   product id gói 1 tháng
 *   POLAR_PRODUCT_YEARLY    product id gói 12 tháng
 *   POLAR_PRODUCT_LIFETIME  product id gói trọn đời
 *   POLAR_SITE_URL          domain web để Polar trả khách về (mặc định https://guidelingo.com)
 */

const SIGNATURE_TOLERANCE_SECONDS = 300

export function polarApiBase() {
  return process.env.POLAR_SERVER === 'production' ? 'https://api.polar.sh' : 'https://sandbox-api.polar.sh'
}

export function polarSiteUrl() {
  return (process.env.POLAR_SITE_URL || 'https://guidelingo.com').replace(/\/+$/, '')
}

export async function polarRequest(path: string, init: { method?: string, body?: any } = {}) {
  const token = process.env.POLAR_ACCESS_TOKEN
  if (!token)
    throw new Error('POLAR_ACCESS_TOKEN chưa được cấu hình')

  const res = await fetch(`${polarApiBase()}${path}`, {
    method: init.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  }
  catch {
    data = text
  }
  if (!res.ok)
    throw new Error(`Polar ${init.method || 'GET'} ${path} -> ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
  return data
}

/**
 * A Polar product as a Kim cương pack needs it: one-time, one fixed USD price. Read when the team saves the
 * pack's product id in the admin, so the price shown on /pricing is the price Polar charges.
 */
export async function polarPackProduct(productId: string): Promise<{ ok: true, priceCents: number, name: string } | { ok: false, error: string }> {
  let p: any
  try {
    p = await polarRequest(`/v1/products/${encodeURIComponent(productId)}`)
  }
  catch (e: any) {
    return { ok: false, error: /-> 404/.test(String(e?.message)) ? 'Không tìm thấy sản phẩm này trên Polar (kiểm tra sandbox/production).' : `Không đọc được sản phẩm từ Polar: ${String(e?.message || e).slice(0, 200)}` }
  }
  if (p?.is_recurring)
    return { ok: false, error: 'Sản phẩm này là gói định kỳ (Recurring). Gói Kim cương phải là One-time purchase.' }
  if (p?.is_archived)
    return { ok: false, error: 'Sản phẩm này đã bị lưu trữ (archived) trên Polar.' }
  const price = (p?.prices || []).find((x: any) => !x.is_archived && x.amount_type === 'fixed' && String(x.price_currency || 'usd').toLowerCase() === 'usd')
  if (!price || !(Number(price.price_amount) > 0))
    return { ok: false, error: 'Sản phẩm cần một giá cố định (Fixed price) bằng USD.' }
  return { ok: true, priceCents: Number(price.price_amount), name: String(p.name || '') }
}

/**
 * Các key có thể dùng để ký, theo thứ tự thử:
 *   - Standard Webhooks (secret tạo từ 08/09/2026): `whsec_<base64>` -> key = base64-decode phần sau `whsec_`
 *   - Kiểu cũ của Polar (secret tạo trước đó): key = bytes UTF-8 của nguyên chuỗi secret
 */
function signingKeys(secret: string): Buffer[] {
  const keys: Buffer[] = []
  if (secret.startsWith('whsec_')) {
    const decoded = Buffer.from(secret.slice('whsec_'.length), 'base64')
    if (decoded.length)
      keys.push(decoded)
  }
  keys.push(Buffer.from(secret, 'utf8'))
  return keys
}

/**
 * Xác thực webhook theo Standard Webhooks: ký HMAC-SHA256 trên
 * `${webhook-id}.${webhook-timestamp}.${raw body}`, header `webhook-signature` dạng
 * "v1,<base64> v1,<base64>" (có thể nhiều chữ ký khi đang xoay secret).
 */
export function verifyPolarSignature(req: any, secret: string, logger: any): boolean {
  const id = String(req.headers['webhook-id'] || '')
  const timestamp = String(req.headers['webhook-timestamp'] || '')
  const signatureHeader = String(req.headers['webhook-signature'] || '')

  if (!id || !timestamp || !signatureHeader) {
    logger.warn('[Polar] Thiếu header webhook-id / webhook-timestamp / webhook-signature')
    return false
  }

  const rawBody: Buffer | undefined = req.rawBody
  if (!rawBody) {
    logger.error('[Polar] Không có rawBody — middleware giữ raw body (hook/sepayRawBody.ts) chưa gắn cho đường dẫn webhook')
    return false
  }

  const skewSeconds = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(skewSeconds) || skewSeconds > SIGNATURE_TOLERANCE_SECONDS) {
    logger.warn(`[Polar] Timestamp lệch ${Math.round(skewSeconds)}s (cho phép ${SIGNATURE_TOLERANCE_SECONDS}s)`)
    return false
  }

  const signedPayload = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), rawBody])
  const received = signatureHeader
    .split(' ')
    .map(part => part.split(',')[1])
    .filter(Boolean)
    .map(sig => Buffer.from(sig as string, 'base64'))

  for (const key of signingKeys(secret)) {
    const expected = createHmac('sha256', key).update(signedPayload).digest()
    if (received.some(sig => sig.length === expected.length && timingSafeEqual(sig, expected)))
      return true
  }

  logger.warn('[Polar] Chữ ký webhook không khớp')
  return false
}
