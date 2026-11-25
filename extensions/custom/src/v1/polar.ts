import { createHash } from 'node:crypto'
import type { Router } from 'express'
import { notifyAdmin } from '../lib/telegram'
import { voidConversion } from '../lib/referrals'
import { chargebackCoinOrder, orderWait, packCoins } from '../lib/gemOrders'
import { gemsOn } from '../lib/growthConfig'
import {
  polarRequest,
  polarSiteUrl,
  verifyPolarSignature,
} from '../lib/polar'

/**
 * Thanh toán thẻ quốc tế qua Polar: chỉ bán gói Kim cương.
 *
 *   POST /v1/polar/coins/checkout -> tạo phiên thanh toán cho một gói (xu_packs.polar_product_id, mua một lần), trả URL
 *   GET  /v1/polar/checkout/:id   -> trạng thái đơn của phiên đó (trang /checkout/success hỏi vòng)
 *   POST /v1/polar-webhook        -> Polar báo đơn đã trả tiền / đã hoàn tiền
 *
 * Đơn là một dòng `purchase_histories` chuyển `pending` -> `published`; Kim cương được cộng một lần
 * (lib/gemOrders.ts). Với đơn Polar: `transfer_code` = id phiên checkout (hoặc id order khi trả qua link
 * không có đơn chờ), `amount` / `price_original` tính bằng CENT.
 */

function adminItems(context: any, schema: any, collection: string) {
  const { ItemsService } = context.services
  return new ItemsService(collection, { schema, accountability: { admin: true } })
}

/** Người mua của một order: external_id gắn lúc tạo checkout, rồi tới metadata, cuối cùng là email */
async function resolveUserId(order: any, database: any): Promise<string | null> {
  const direct = order?.customer?.external_id || order?.metadata?.user_id
  if (direct)
    return String(direct)
  const email = String(order?.customer?.email || '').trim().toLowerCase()
  if (!email)
    return null
  const row = await database('directus_users').whereRaw('lower(email) = ?', [email]).first('id')
  return row?.id || null
}

/** The Kim cương pack an order bought: its metadata (set on our checkout), else its product id */
async function packOfOrder(order: any, database: any) {
  const code = order?.metadata?.pack_code
  if (code) {
    const byCode = await database('xu_packs').where('code', String(code)).first()
    if (byCode)
      return byCode
  }
  const productId = order?.product_id || order?.product?.id
  return productId ? database('xu_packs').where('polar_product_id', String(productId)).first() : null
}

const usd = (cents: any, currency: any) => `${(Number(cents || 0) / 100).toFixed(2)} ${String(currency || 'usd').toUpperCase()}`

/** The same Polar order always gets the same uuid */
function idOfPolarOrder(orderId: string) {
  const h = createHash('sha256').update(`polar:${orderId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * A paid Kim cương order: its row goes pending -> published through ItemsService, so the hook
 * purchase_histories.items.update pays the Kim cương once (lib/gemOrders.ts creditCoinOrder), as for a bank transfer.
 */
async function settleCoinOrder(order: any, pack: any, userId: string, context: any): Promise<string> {
  const schema = await context.getSchema()
  const purchases = adminItems(context, schema, 'purchase_histories')
  const keys = [order.checkout_id, order.id].filter(Boolean)
  const found = await purchases.readByQuery({
    filter: { transfer_code: { _in: keys }, payment_method: { _eq: 'polar' }, product_type: { _eq: 'coins' } },
    limit: 1,
    fields: ['id', 'status'],
  })
  let row = found && found[0] ? found[0] : null
  if (row && row.status !== 'pending')
    return 'already-settled'
  if (!row) {
    // Paid without our checkout (e.g. a shared Polar link): the order still pays the pack it bought
    // The row's id comes from the Polar order id: webhooks arriving together can only make one row
    const id = idOfPolarOrder(order.id)
    try {
      await purchases.createOne({
        id,
        user: userId,
        amount: order.total_amount,
        price_original: order.subtotal_amount ?? order.total_amount,
        currency: String(order.currency || 'usd').toLowerCase(),
        status: 'pending',
        payment_method: 'polar',
        transfer_code: order.id,
        type: 'gems',
        product_type: 'coins',
        pack_code: pack.code,
        coins: packCoins(pack),
      })
      row = { id, status: 'pending' }
    }
    catch (error) {
      row = await context.database('purchase_histories').where('id', id).first('id', 'status')
      if (!row)
        throw error
      if (row.status !== 'pending')
        return 'already-settled'
    }
  }
  const updated = await purchases.updateByQuery(
    { filter: { id: { _eq: row.id }, status: { _eq: 'pending' } } },
    {
      status: 'published',
      amount: order.total_amount,
      vat_amount: Number(order.tax_amount) || 0,
      price_subtotal: order.net_amount ?? null,
      date_transfer: new Date().toISOString(),
    },
  )
  if (!updated || updated.length === 0)
    return 'already-settled'
  context.logger.info(`[Polar] Order ${order.id} -> Kim cương gói ${pack.code} cho ${userId}`)
  notifyAdmin(`✅ Polar: nạp Kim cương THÀNH CÔNG\nGói: ${pack.code}\nOrder: ${order.id}\nSố tiền: ${usd(order.total_amount, order.currency)}\nEmail: ${order?.customer?.email || ''}`)
  return 'activated'
}

async function settlePolarOrder(order: any, context: any): Promise<string> {
  const { database } = context

  const userId = await resolveUserId(order, database)
  if (!userId) {
    notifyAdmin(`⚠️ Polar: order ${order.id} đã trả tiền nhưng KHÔNG xác định được user.\nEmail: ${order?.customer?.email}`)
    return 'no-user'
  }

  // A renewal of a subscription is never a Kim cương order, whatever product it carries
  const fromSubscription = !!order.subscription_id || String(order.billing_reason || '').startsWith('subscription')
  const pack = fromSubscription ? null : await packOfOrder(order, database)
  if (pack)
    return settleCoinOrder(order, pack, userId, context)

  notifyAdmin(`⚠️ Polar: order ${order.id} đã trả tiền nhưng không thuộc gói Kim cương nào (product ${order.product_id}).\nEmail: ${order?.customer?.email || ''}`)
  return 'unknown-product'
}

async function recordPolarRefund(order: any, context: any) {
  const { logger } = context
  const keys = [order.id, order.checkout_id].filter(Boolean)
  const fullRefund = order.status === 'refunded'

  // Kim cương: a full refund takes them back (what was spent becomes debt, the account is flagged)
  const coinRows = await context.database('purchase_histories').whereIn('transfer_code', keys).where({ payment_method: 'polar', product_type: 'coins' }).select('id', 'status')
  if (coinRows.length) {
    let note = 'Hoàn một phần: Kim cương KHÔNG bị thu hồi, xử lý tay ở /admin/gems-content nếu cần.'
    if (fullRefund) {
      for (const r of coinRows) {
        try {
          const c = await chargebackCoinOrder(context.database, r.id)
          note = `Đã thu hồi ${c.taken} Kim cương${c.debt ? `, còn nợ ${c.debt}` : ''}; tài khoản bị gắn cờ.`
        }
        catch {
          // Never credited (or taken back already): only the order's status changes
          await context.database('purchase_histories').where('id', r.id).update({ status: 'refunded' })
          note = 'Đơn chưa cộng Kim cương hoặc đã thu hồi trước đó.'
        }
      }
      await voidConversion(context.database, coinRows.map((r: any) => r.id))
    }
    logger.warn(`[Polar] Order ${order.id} (Kim cương) hoàn ${usd(order.refunded_amount, order.currency)}`)
    notifyAdmin(`↩️ Polar: đơn Kim cương ${order.id} đã HOÀN ${usd(order.refunded_amount, order.currency)} (${fullRefund ? 'toàn phần' : 'một phần'}).\nEmail: ${order?.customer?.email || ''}\n${note}`)
    return
  }

  // Not a Kim cương order of ours: the admin looks at it
  const refunded = usd(order.refunded_amount, order.currency)
  logger.warn(`[Polar] Order ${order.id} hoàn tiền ${refunded}, không khớp đơn Kim cương nào`)
  notifyAdmin(`↩️ Polar: order ${order.id} đã HOÀN ${refunded}, không khớp đơn Kim cương nào.\nEmail: ${order?.customer?.email || ''}`)
}

export function handlePolar(router: Router, context: any) {
  const { logger, database, getSchema } = context

  // Kim cương pack by card: the same Polar hosted checkout, the order row is a coin order (product_type 'coins')
  router.post('/polar/coins/checkout', async (req: any, res: any) => {
    const userId = req.accountability?.user
    if (!userId)
      return res.status(401).json({ success: false, code: 'UNAUTHORIZED' })
    if (!gemsOn('purchase', req.accountability))
      return res.status(403).json({ success: false, code: 'PURCHASE_OFF' })
    try {
      const pack = await database('xu_packs').where({ code: String(req.body?.pack_code || ''), active: true }).first()
      if (!pack)
        return res.status(404).json({ success: false, code: 'NO_PACK' })
      if (!pack.polar_product_id)
        return res.status(400).json({ success: false, code: 'NO_CARD' })
      const wait = await orderWait(database, userId)
      if (wait)
        return res.status(429).json({ success: false, code: 'TOO_MANY_ORDERS', wait_min: wait })

      const buyer = await database('directus_users').where('id', userId).first('email')
      const site = polarSiteUrl()
      const checkout = await polarRequest('/v1/checkouts/', {
        method: 'POST',
        body: {
          products: [pack.polar_product_id],
          external_customer_id: userId,
          customer_email: buyer?.email || undefined,
          success_url: `${site}/checkout/success?checkout_id={CHECKOUT_ID}`,
          return_url: `${site}/pricing`,
          metadata: { user_id: userId, pack_code: pack.code, kind: 'coins' },
        },
      })
      const schema = await getSchema()
      await adminItems(context, schema, 'purchase_histories').createOne({
        user: userId,
        amount: checkout.total_amount ?? checkout.amount,
        price_original: checkout.amount,
        currency: String(checkout.currency || 'usd').toLowerCase(),
        status: 'pending',
        payment_method: 'polar',
        transfer_code: checkout.id,
        expire_time: checkout.expires_at || null,
        type: 'gems',
        product_type: 'coins',
        pack_code: pack.code,
        coins: packCoins(pack),
      })
      return res.status(200).json({ success: true, url: checkout.url, checkout_id: checkout.id })
    }
    catch (error: any) {
      logger.error(`[Polar] Tạo checkout Kim cương thất bại: ${String(error?.message || error)}`)
      return res.status(502).json({ success: false, code: 'CARD_UNAVAILABLE' })
    }
  })

  router.get('/polar/checkout/:id', async (req: any, res: any) => {
    const userId = req.accountability?.user
    if (!userId)
      return res.status(401).json({ success: false, error: 'Unauthorized' })

    const row = await database('purchase_histories')
      .where({ transfer_code: String(req.params.id), user: userId, payment_method: 'polar', product_type: 'coins' })
      .first('status', 'coins', 'pack_code')
    if (!row)
      return res.status(404).json({ success: false, error: 'Order not found' })
    return res.status(200).json({ success: true, status: row.status, coins: row.coins ?? null })
  })

  router.post('/polar-webhook', async (req: any, res: any) => {
    const secret = process.env.POLAR_WEBHOOK_SECRET
    if (!secret) {
      logger.error('[Polar] Chưa cấu hình POLAR_WEBHOOK_SECRET — từ chối webhook')
      return res.status(401).json({ success: false })
    }
    if (!verifyPolarSignature(req, secret, logger))
      return res.status(401).json({ success: false })

    const event = req.body || {}
    try {
      if (event.type === 'order.paid') {
        const result = await settlePolarOrder(event.data || {}, context)
        if (result !== 'activated')
          logger.info(`[Polar] Order ${event.data?.id}: ${result}`)
      }
      else if (event.type === 'order.refunded') {
        await recordPolarRefund(event.data || {}, context)
      }
      else {
        logger.info(`[Polar] Bỏ qua event ${event.type}`)
      }
      return res.status(200).json({ success: true })
    }
    catch (error: any) {
      // Trả 5xx để Polar gửi lại (tối đa 10 lần, giãn dần)
      logger.error(`[Polar] Lỗi xử lý webhook ${event.type} ${event.data?.id}: ${String(error?.stack || error)}`)
      return res.status(500).json({ success: false })
    }
  })
}
