import { customAlphabet } from 'nanoid'

/**
 * Mã thanh toán (nội dung chuyển khoản) — PHẢI khớp với "Cấu hình mã thanh toán"
 * khai trên SePay (Cấu hình công ty → Cấu hình chung), nếu không SePay trả về
 * `code: null` trong webhook và không có cách nào biết tiền vào là của đơn nào.
 *
 * Cần khai trên SePay (Cấu hình chung → mẫu mã thanh toán) đúng như dưới đây:
 *   - Tiền tố : GL
 *   - Hậu tố  : 8 ký tự, kiểu "Số nguyên"
 *
 * Dù khai đúng hay sai trên SePay, webhook vẫn chạy đúng vì luôn tự bóc lại mã
 * từ nội dung chuyển khoản gốc (xem pickPaymentCode) thay vì tin thẳng field
 * `code` mà SePay trả về — tránh lặp lại lỗi "SePay cắt ngắn code do khai sai
 * độ dài hậu tố" đã từng gặp ở project khác.
 */
export const PAYMENT_CODE_PREFIX = 'GL'
const PAYMENT_CODE_LENGTH = 8

/**
 * Chỉ chữ số, đúng kiểu "Số nguyên" của cấu hình SePay. 10^8 = 100 triệu tổ hợp,
 * trùng chỉ là vấn đề giữa các đơn CÙNG đang `pending` — thừa an toàn cho quy mô
 * hiện tại. Toàn số cũng giúp khách chuyển khoản qua ATM/POS gõ tay không lẫn.
 */
const PAYMENT_CODE_ALPHABET = '0123456789'
const randomSuffix = customAlphabet(PAYMENT_CODE_ALPHABET, PAYMENT_CODE_LENGTH)

export function newPaymentCode(): string {
  return `${PAYMENT_CODE_PREFIX}${randomSuffix()}`
}

const CURRENT_CODE_REGEX = new RegExp(`${PAYMENT_CODE_PREFIX}[0-9A-Z]{${PAYMENT_CODE_LENGTH}}`)

/**
 * Mã cũ (trước khi đổi sang định dạng GL+số): 11 ký tự chữ+số bất kỳ, sinh bởi
 * customAlphabet(alphabet, 11) trong checkout.ts bản trước. Giữ lại để các đơn
 * `pending` tạo trước khi đổi định dạng vẫn được webhook nhận diện đúng cho tới
 * khi hết hạn tự nhiên (không còn đơn pending nào dùng định dạng cũ nữa).
 */
const LEGACY_CODE_REGEX = /\b[0-9a-z]{11}\b/i

/**
 * Bóc mã thanh toán từ nội dung chuyển khoản. Dùng khi SePay không tự bóc được
 * (`code: null`) hoặc để kiểm chứng lại field `code` mà SePay trả về.
 */
export function extractPaymentCode(content: string): string {
  const raw = String(content || '')
  const current = raw.toUpperCase().match(CURRENT_CODE_REGEX)
  if (current)
    return current[0]

  const legacy = raw.match(LEGACY_CODE_REGEX)
  return legacy ? legacy[0] : ''
}

/**
 * Chốt mã thanh toán từ dữ liệu SePay gửi về (`code` + nội dung chuyển khoản).
 *
 * KHÔNG tin `code` một cách vô điều kiện: nếu hậu tố khai trên SePay ngắn hơn
 * mã thật, SePay sẽ CẮT NGẮN `code` — lỗi này im lặng tuyệt đối (webhook vẫn
 * 200, vẫn không khớp đơn nào, khách vẫn mất tiền). Thứ tự ưu tiên: `code`
 * đúng định dạng → bóc lại từ nội dung chuyển khoản → cuối cùng mới dùng `code`
 * thô làm phương án chót.
 */
export function pickPaymentCode(sepayCode: string | null | undefined, content: string): string {
  const code = String(sepayCode ?? '').trim().toUpperCase()

  const exact = code.match(CURRENT_CODE_REGEX)
  if (exact)
    return exact[0]

  const fromContent = extractPaymentCode(content)
  if (fromContent)
    return fromContent

  return code
}
