import { pickPaymentCode } from '../v1/paymentCode'

export type SettleResult = 'activated' | 'already-settled' | 'no-match' | 'underpaid' | 'expired' | 'ignored'

export interface SepayTxInput {
  id?: number | string
  content?: string
  code?: string | null
  amountIn: number
  referenceCode?: string
}

let bot: any = null
try {
  if (process.env.TELEGRAM_BOT_TOKEN) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const TelegramBot = require('node-telegram-bot-api')
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false })
  }
}
catch {
  bot = null
}

function notifyAdmin(message: string) {
  if (!bot)
    return
  const groupChatId = process.env.TELEGRAM_GROUP_ID || '-5020831863'
  bot.sendMessage(groupChatId, message).catch(() => {})
}

/**
 * Khớp một giao dịch SePay báo về với đơn hàng `purchase_histories` đang `pending`,
 * và nếu đủ tiền thì đánh dấu `published` — hook có sẵn `purchase_histories.items.update`
 * (xem hook/index.ts) sẽ tự kích hoạt Premium, không cần gọi lại activatePremiumForUser
 * ở đây (tránh trùng logic ở hai chỗ).
 *
 * Idempotent: dùng `updateByQuery` với điều kiện `status = 'pending'` ngay trong câu
 * update, nên nếu SePay gọi lại webhook (retry) hoặc admin đã tự publish tay trước đó,
 * lần thứ hai sẽ không tìm thấy dòng `pending` nữa và trả về 'already-settled' thay vì
 * kích hoạt/thông báo trùng lần hai.
 */
export async function settleSepayTransaction(tx: SepayTxInput, context: any): Promise<SettleResult> {
  const { services, getSchema, logger } = context
  const { ItemsService } = services

  const amountIn = Number(tx.amountIn || 0)
  if (!amountIn)
    return 'ignored'

  const paymentCode = pickPaymentCode(tx.code, tx.content || '')
  if (!paymentCode) {
    logger.warn(`[SePay] Không bóc được mã thanh toán. content="${tx.content}"`)
    notifyAdmin(`⚠️ SePay báo tiền vào ${amountIn.toLocaleString('vi-VN')}đ nhưng KHÔNG đọc được mã đơn.\nNội dung: ${tx.content}`)
    return 'no-match'
  }

  const schema = await getSchema()
  const purchaseHistoryService = new ItemsService('purchase_histories', {
    schema,
    accountability: { admin: true },
  })

  const found = await purchaseHistoryService.readByQuery({
    filter: { transfer_code: { _eq: paymentCode } },
    limit: 1,
    fields: ['*'],
  })
  const order = found && found[0] ? found[0] : null

  if (!order) {
    logger.warn(`[SePay] Mã ${paymentCode} không khớp đơn nào`)
    notifyAdmin(`⚠️ Không tìm thấy đơn hàng cho mã ${paymentCode}.\nSố tiền: ${amountIn.toLocaleString('vi-VN')}đ\nNội dung: ${tx.content}`)
    return 'no-match'
  }

  if (order.status !== 'pending')
    return 'already-settled'

  if (order.expire_time && new Date(order.expire_time).getTime() < Date.now()) {
    logger.warn(`[SePay] Đơn ${paymentCode} đã hết hạn nhưng vẫn nhận tiền vào`)
    notifyAdmin(`⚠️ Đơn ${paymentCode} đã HẾT HẠN nhưng khách vẫn chuyển ${amountIn.toLocaleString('vi-VN')}đ.\nCần admin kiểm tra tay (kích hoạt hộ hay hoàn tiền) tại purchase_histories.`)
    return 'expired'
  }

  if (amountIn < Number(order.amount || 0)) {
    logger.warn(`[SePay] Đơn ${paymentCode} chuyển thiếu: nhận ${amountIn}, cần ${order.amount}`)
    notifyAdmin(`⚠️ Đơn ${paymentCode} chuyển THIẾU tiền.\nNhận: ${amountIn.toLocaleString('vi-VN')}đ, cần: ${Number(order.amount).toLocaleString('vi-VN')}đ`)
    return 'underpaid'
  }

  const updatedIds = await purchaseHistoryService.updateByQuery(
    { filter: { id: { _eq: order.id }, status: { _eq: 'pending' } } },
    { status: 'published', payment_method: 'sepay', date_transfer: new Date().toISOString() },
  )

  if (!updatedIds || updatedIds.length === 0)
    return 'already-settled'

  logger.info(`[SePay] Kích hoạt thành công đơn ${paymentCode}`)
  notifyAdmin(`✅ Thanh toán tự động qua SePay THÀNH CÔNG\nĐơn: ${paymentCode}\nSố tiền: ${amountIn.toLocaleString('vi-VN')}đ`)
  return 'activated'
}
