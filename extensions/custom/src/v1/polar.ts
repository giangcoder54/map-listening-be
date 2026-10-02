import type { Router } from 'express'
import { notifyAdmin } from '../lib/sepay'
import {
  polarCycleForProduct,
  polarProductForCycle,
  polarRequest,
  polarSiteUrl,
  verifyPolarSignature,
} from '../lib/polar'

/**
 * Thanh toán thẻ quốc tế qua Polar.
 *
 *   POST /v1/polar/checkout       -> tạo phiên thanh toán Polar, trả URL để FE chuyển khách sang
 *   GET  /v1/polar/checkout/:id   -> trạng thái đơn của phiên đó (trang /checkout/success hỏi vòng)
 *   POST /v1/polar-webhook        -> Polar báo đơn đã trả tiền / đã hoàn tiền
 *
 * Mỗi lần Polar thu tiền (mua lần đầu hay tự gia hạn) là một dòng `purchase_histories`
 * chuyển `pending` -> `published`; hook có sẵn `purchase_histories.items.update`
 * (hook/index.ts) tự kích hoạt Premium như luồng SePay, không lặp lại logic ở đây.
 *
 * Với đơn Polar: `transfer_code` = id phiên checkout (lần mua đầu) hoặc id order (lần gia
 * hạn), `amount` / `price_original` tính bằng CENT theo `currency` (thường là 'usd').
 */

const LIFETIME = 0

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

async function settlePolarOrder(order: any, context: any): Promise<string> {
  const { database, getSchema, logger } = context

  const userId = await resolveUserId(order, database)
  if (!userId) {
    notifyAdmin(`⚠️ Polar: order ${order.id} đã trả tiền nhưng KHÔNG xác định được user.\nEmail: ${order?.customer?.email}`)
    return 'no-user'
  }

  const cycle = polarCycleForProduct(order.product_id || order.product?.id, order.product?.metadata)
  if (cycle === null) {
    notifyAdmin(`⚠️ Polar: order ${order.id} thuộc product ${order.product_id} chưa có duration_month (metadata hoặc env POLAR_PRODUCT_*).`)
    return 'unknown-product'
  }

  // Lần mua đầu khớp với dòng pending tạo lúc checkout (theo id phiên). Đơn tự gia hạn
  // không được khớp theo checkout_id — có thể nó vẫn mang id phiên gốc, và dòng đó đã
  // published từ lần đầu, sẽ bị nhận nhầm là "đã xử lý".
  const isFirstPurchase = !order.billing_reason || ['purchase', 'subscription_create'].includes(order.billing_reason)
  const keys = (isFirstPurchase ? [order.checkout_id, order.id] : [order.id]).filter(Boolean)

  const schema = await getSchema()
  const purchases = adminItems(context, schema, 'purchase_histories')

  const found = await purchases.readByQuery({
    filter: { transfer_code: { _in: keys }, payment_method: { _eq: 'polar' } },
    limit: 1,
    fields: ['id', 'status'],
  })
  let row = found && found[0] ? found[0] : null

  if (row && row.status !== 'pending')
    return 'already-settled'

  if (!row) {
    const plan = await database('plans').where('code', order.metadata?.plan_code || 'premium').first('id', 'code')
    const id = await purchases.createOne({
      user: userId,
      plan_id: plan?.id || null,
      billing_cycle: cycle,
      amount: order.total_amount,
      price_original: order.subtotal_amount ?? order.total_amount,
      currency: String(order.currency || 'usd').toLowerCase(),
      status: 'pending',
      payment_method: 'polar',
      transfer_code: order.id,
      type: plan?.code || 'premium',
      auto_renew: cycle !== LIFETIME,
    })
    row = { id, status: 'pending' }
  }

  // Điều kiện status = 'pending' nằm ngay trong câu update: Polar gửi lại webhook thì lần
  // sau không còn dòng pending nào, không kích hoạt hai lần.
  const updated = await purchases.updateByQuery(
    { filter: { id: { _eq: row.id }, status: { _eq: 'pending' } } },
    {
      status: 'published',
      amount: order.total_amount,
      date_transfer: new Date().toISOString(),
    },
  )
  if (!updated || updated.length === 0)
    return 'already-settled'

  const money = `${(Number(order.total_amount || 0) / 100).toFixed(2)} ${String(order.currency || 'usd').toUpperCase()}`
  logger.info(`[Polar] Order ${order.id} (${order.billing_reason}) -> kích hoạt Premium ${cycle === LIFETIME ? 'trọn đời' : `${cycle} tháng`} cho ${userId}`)
  notifyAdmin(`✅ Polar: ${order.billing_reason === 'subscription_cycle' ? 'gia hạn' : 'thanh toán'} THÀNH CÔNG\nOrder: ${order.id}\nSố tiền: ${money}\nEmail: ${order?.customer?.email || ''}`)
  return 'activated'
}

async function recordPolarRefund(order: any, context: any) {
  const { getSchema, logger } = context
  const schema = await getSchema()
  const purchases = adminItems(context, schema, 'purchase_histories')
  const keys = [order.id, order.checkout_id].filter(Boolean)
  const fullRefund = order.status === 'refunded'

  if (fullRefund) {
    await purchases.updateByQuery(
      { filter: { transfer_code: { _in: keys }, payment_method: { _eq: 'polar' } } },
      { status: 'refunded' },
    )
  }

  // Thu hồi Premium vẫn để admin làm tay: một user có thể còn đơn khác đang hiệu lực.
  const refunded = `${(Number(order.refunded_amount || 0) / 100).toFixed(2)} ${String(order.currency || 'usd').toUpperCase()}`
  logger.warn(`[Polar] Order ${order.id} hoàn tiền ${refunded} (${fullRefund ? 'toàn phần' : 'một phần'})`)
  notifyAdmin(`↩️ Polar: order ${order.id} đã HOÀN ${refunded} (${fullRefund ? 'toàn phần' : 'một phần'}).\nEmail: ${order?.customer?.email || ''}\nKiểm tra và thu hồi Premium tay nếu cần.`)
}

export function handlePolar(router: Router, context: any) {
  const { logger, database, getSchema } = context

  router.post('/polar/checkout', async (req: any, res: any) => {
    const userId = req.accountability?.user
    if (!userId)
      return res.status(401).json({ success: false, error: 'Unauthorized' })

    const { plan_id, billing_cycle } = req.body || {}
    const cycle = Number(billing_cycle)
    const productId = Number.isFinite(cycle) ? polarProductForCycle(cycle) : null
    if (!productId)
      return res.status(400).json({ success: false, error: 'This plan is not available for card payment yet.' })

    try {
      const buyer = await database('directus_users')
        .select('email', 'subscription_type', 'is_premium', 'premium_until')
        .where('id', userId)
        .first()
      if (buyer?.subscription_type === 'lifetime')
        return res.status(409).json({ success: false, error: 'You already have lifetime Premium.' })

      // Còn hạn Premium mà mua thêm gói tháng/năm là tạo subscription thứ hai, khách bị trừ
      // tiền hai lần. Chỉ cho phép nâng lên lifetime.
      const activeUntil = buyer?.premium_until ? new Date(buyer.premium_until).getTime() : 0
      if (buyer?.is_premium && activeUntil > Date.now() && cycle !== LIFETIME)
        return res.status(409).json({ success: false, error: 'You already have an active Premium plan.' })

      const plan = await database('plans')
        .where('status', 'published')
        .whereIn('code', [String(plan_id || 'premium'), 'premium'])
        .first('id', 'code')

      const site = polarSiteUrl()
      const checkout = await polarRequest('/v1/checkouts/', {
        method: 'POST',
        body: {
          products: [productId],
          external_customer_id: userId,
          customer_email: buyer?.email || undefined,
          success_url: `${site}/checkout/success?checkout_id={CHECKOUT_ID}`,
          return_url: `${site}/pricing`,
          metadata: { user_id: userId, plan_code: plan?.code || 'premium', billing_cycle: String(cycle) },
        },
      })

      const schema = await getSchema()
      await adminItems(context, schema, 'purchase_histories').createOne({
        user: userId,
        plan_id: plan?.id || null,
        billing_cycle: cycle,
        amount: checkout.total_amount ?? checkout.amount,
        price_original: checkout.amount,
        currency: String(checkout.currency || 'usd').toLowerCase(),
        status: 'pending',
        payment_method: 'polar',
        transfer_code: checkout.id,
        expire_time: checkout.expires_at || null,
        type: plan?.code || 'premium',
        auto_renew: cycle !== LIFETIME,
      })

      return res.status(200).json({ success: true, url: checkout.url, checkout_id: checkout.id })
    }
    catch (error: any) {
      logger.error(`[Polar] Tạo checkout thất bại: ${String(error?.message || error)}`)
      return res.status(502).json({ success: false, error: 'Card payment is temporarily unavailable, please try again later.' })
    }
  })

  router.get('/polar/checkout/:id', async (req: any, res: any) => {
    const userId = req.accountability?.user
    if (!userId)
      return res.status(401).json({ success: false, error: 'Unauthorized' })

    const row = await database('purchase_histories')
      .where({ transfer_code: String(req.params.id), user: userId, payment_method: 'polar' })
      .first('status', 'billing_cycle')
    if (!row)
      return res.status(404).json({ success: false, error: 'Order not found' })
    return res.status(200).json({ success: true, status: row.status, billing_cycle: row.billing_cycle })
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
        // subscription.canceled / revoked: không cần làm gì — Premium tự hết theo premium_until
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
