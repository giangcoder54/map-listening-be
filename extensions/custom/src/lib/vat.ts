/**
 * VAT_RATE tính theo %, ví dụ VAT_RATE=10 nghĩa là 10%. Mặc định 0 (CHƯA áp dụng)
 * cho tới khi bên vận hành đăng ký thuế và cần xuất hoá đơn GTGT thật.
 * Đổi hành vi tính tiền chỉ bằng biến môi trường, không phải sửa code.
 */
function currentVatRate(): number {
  return Number(process.env.VAT_RATE || 0) / 100
}

/** Cộng VAT vào một số tiền CHƯA có thuế. */
export function addVat(preTaxAmount: number): number {
  return Math.round(preTaxAmount * (1 + currentVatRate()))
}

export interface VatBreakdown {
  subtotal: number
  vatRate: number // đơn vị %, ví dụ 10 (không phải 0.1)
  vatAmount: number
  total: number
}

/**
 * Bóc breakdown từ một số tiền ĐÃ GỒM thuế (tức số tiền khách thực trả).
 * Khi VAT_RATE = 0, subtotal = total, vatAmount = 0 — không đổi hành vi hiện tại.
 */
export function breakdownFromPreTax(totalWithVat: number): VatBreakdown {
  const rate = currentVatRate()
  if (rate <= 0) {
    return { subtotal: totalWithVat, vatRate: 0, vatAmount: 0, total: totalWithVat }
  }
  const subtotal = Math.round(totalWithVat / (1 + rate))
  const vatAmount = totalWithVat - subtotal
  return { subtotal, vatRate: rate * 100, vatAmount, total: totalWithVat }
}
