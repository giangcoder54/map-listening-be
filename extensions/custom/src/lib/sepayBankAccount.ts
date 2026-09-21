/**
 * Lấy tài khoản nhận tiền để in lên QR và để webhook SePay đối chiếu.
 *
 * Tích hợp gọi API SePay để lấy danh sách tài khoản động, 
 * sử dụng SEPAY_API_BASE_URL và API Token (SEPAY_BANK_ACCOUNT).
 */
export interface ReceivingAccount {
  bankBin: string
  bankShortName: string
  accountNumber: string
  accountHolderName: string
}

export async function getReceivingAccount(context: any): Promise<ReceivingAccount | null> {
  const { logger, env } = context

  try {
    // Fallback to env if process.env is not fully populated by Directus
    const url = (env?.SEPAY_API_BASE_URL) || process.env.SEPAY_API_BASE_URL || 'https://userapi.sepay.vn/v2/bank-accounts'
    const token = (env?.SEPAY_API_TOKEN) || process.env.SEPAY_API_TOKEN || (env?.SEPAY_BANK_ACCOUNT) || process.env.SEPAY_BANK_ACCOUNT

    logger.info(`[Payments] URL: ${url}, Token present: ${!!token}`)

    if (!token) {
      logger.error('[Payments] Missing SePay API Token (SEPAY_API_TOKEN or SEPAY_BANK_ACCOUNT in .env)')
      return null
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      logger.error(`[Payments] SePay API HTTP error: ${response.status} - ${errText}`)
      return null
    }

    const json = await response.json()
    logger.info(`[Payments] SePay API response: ${JSON.stringify(json)}`)

    if ((json.status !== 'success' && json.status !== 200) || !json.data || json.data.length === 0) {
      logger.error(`[Payments] SePay API returned error or no accounts`)
      return null
    }

    const account = json.data[0]

    // QUAN TRỌNG với BIDV (và vài ngân hàng khác): SePay CHỈ nhận được thông báo
    // tiền vào khi khách chuyển vào TÀI KHOẢN ẢO (VA), không phải số tài khoản
    // chính. Chuyển vào tài khoản chính thì tiền vẫn về, nhưng SePay không hề
    // biết -> tab Giao dịch trống -> webhook không bao giờ bắn.
    // API /v2/bank-accounts chỉ trả tài khoản chính, không có VA, nên số VA khai
    // bằng biến môi trường SEPAY_VA_ACCOUNT (lấy trong SePay > Ngân hàng > tài khoản ảo).
    const vaAccount = (env?.SEPAY_VA_ACCOUNT) || process.env.SEPAY_VA_ACCOUNT || ''
    const vaBankBin = (env?.SEPAY_VA_BANK_BIN) || process.env.SEPAY_VA_BANK_BIN || ''

    if (!vaAccount) {
      logger.warn(
        '[Payments] Chưa khai SEPAY_VA_ACCOUNT — QR sẽ in số tài khoản chính. '
        + 'Với BIDV, tiền chuyển vào tài khoản chính sẽ KHÔNG được SePay ghi nhận.'
      )
    }

    return {
      bankBin: vaBankBin || account.bank_bin || '970432',
      bankShortName: account.bank_short_name || account.bank_name || '',
      accountNumber: vaAccount || account.account_number || account.bank_account_no,
      accountHolderName: account.account_holder_name || account.bank_account_name || '',
    }
  }
  catch (err: any) {
    logger.error(`[Payments] Lỗi gọi API SePay: ${String(err)}`)
    return null
  }
}
