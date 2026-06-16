import type { ItemsService } from '@directus/api/dist/services/items'
import type { DirectusUsers, MasterWallet, PurchaseHistories } from '../../types'
import { defineHook } from '@directus/extensions-sdk'
import axios from 'axios'

// Bank configuration
interface BankConfig {
  name: string
  id: string
  authkey: string
  project: string
  sender: string
  emails: string[]
}

const VPBank_URL = 'https://neo.vpbank.com.vn/cb/odata/ns/authenticationservice/GetNonSecureNotificationShare'

export function getVPBankHeaders(authkey: string) {
  return {
    // # ':authority': 'neo.vpbank.com.vn',
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
    'Authkey': authkey,
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Priority': 'u=1, i',
    'Referer': 'https://neo.vpbank.com.vn/notification-list.html',
    'Sec-Ch-Ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': 'Windows',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    'Connection': 'close',
  }
}

export function registerCronjob({ schedule }: any, { services, getSchema, logger, database }: any) {
  const { ItemsService, UsersService } = services

  schedule('*/1 * * * *', async () => {
    try {
      console.log('alo_123')
      const schema = await getSchema()

      // 1. Fetch Master Wallet info
      const masterWalletService: ItemsService<MasterWallet> = new ItemsService('master_wallet', {
        schema,
        accountability: { admin: true },
      })
      const masterWallet = await masterWalletService.readSingleton({
        fields: ['*'],
      }) as MasterWallet
      logger.info(`masterWallet: ${JSON.stringify(masterWallet)}`)
      if (!masterWallet || !masterWallet.auth_key || !masterWallet.bank_account) {
        logger.info('[Cron][Bank Transactions] Master wallet not configured or missing auth_key/bank_account, skipping...')
        return
      }

      const banks: BankConfig[] = [
        {
          name: masterWallet.bank_account_name?.trim() || '',
          id: masterWallet.bank_account?.trim() || '',
          authkey: masterWallet.auth_key?.trim() || '',
          project: '', // Not used
          sender: '', // Not used
          emails: [], // Not used
        },
      ]

      // const topupWalletService: ItemsService<TopupWallet> = new ItemsService('topup_wallet', {
      //   schema,
      //   accountability: { admin: true },
      // })
      const usersService: ItemsService<DirectusUsers> = new UsersService({
        schema,
        accountability: { admin: true },
      })

      const purchaseHistoryService: ItemsService<PurchaseHistories> = new ItemsService('purchase_histories', {
        schema,
        accountability: { admin: true },
      })

      // Lấy latest topup wallet cho checkpoint
      // const topupWallet = await topupWalletService.readByQuery({
      //   fields: ['*'],
      //   sort: ['-date_transfer'],
      //   limit: 1,
      //   filter: {
      //     _and: [
      //       { type: { _eq: 'auto' } },
      //       { payment_method: { _eq: 'bank_transfer' } },
      //     ],
      //   },
      // })

      // Lấy danh sách purchase_histories đang pending
      const pendingPurchases = await purchaseHistoryService.readByQuery({
        fields: ['*', 'user.*'],
        filter: {
          status: { _eq: 'pending' },
        },
      })
      const lastPurchase = await purchaseHistoryService.readByQuery({
        fields: ['*', 'user.*'],
        sort: ['-date_created'],
        limit: 1,
        filter: {
          status: { _eq: 'published' },
        },
      })
      const latestPurchase = lastPurchase.length > 0 ? lastPurchase[0] as PurchaseHistories : null
      const latestDateTransfer = latestPurchase?.date_transfer || latestPurchase?.date_created || ''
      const latestTraceId = '' // Default to empty if not using trace_id field

      logger.info(`[Cron][Bank Transactions] Found ${pendingPurchases.length} pending purchases`)

      for (const bank of banks) {
        try {
          await checkBankTransactions(
            bank,
            logger,
            latestDateTransfer,
            latestTraceId,
            usersService,
            purchaseHistoryService,
            pendingPurchases,
            database,
          )
        }
        catch (error) {
          logger.error(`[Bank Transactions] Error checking bank ${bank.name}: ${String(error)}`)
        }
      }

      logger.info('[Cron][Bank Transactions] Bank transaction check completed')
    }
    catch (error) {
      logger.error(`[Cron][Bank Transactions] Fatal error: ${String(error)}`)
    }
  })
}

async function checkBankTransactions(
  bank: BankConfig,
  logger: any,
  latestDateTransfer?: string,
  latestTraceId?: string,
  usersService?: ItemsService<DirectusUsers>,
  purchaseHistoryService?: ItemsService<PurchaseHistories>,
  pendingPurchases?: PurchaseHistories[],
  database?: any,
) {
  try {
    logger.info(`[Cron][Bank Transactions] Checking transactions for ${bank.name}...`)
    logger.info(`bank.authkey: ${bank.authkey}`)
    const response = await axios.get(VPBank_URL, {
      headers: getVPBankHeaders(bank.authkey),
      timeout: 120000,
    })
    logger.info(`có_data_rồi: ${JSON.stringify(response.data)}`)

    if (response.status !== 200) {
      logger.error(`[Cron][Bank Transactions] VPBank API returned status ${response.status}`)
      return
    }

    const body = response.data
    if (!body.d) {
      logger.error(`[Cron][Bank Transactions] Body response missing 'd': ${JSON.stringify(body)}`)
      return
    }

    if (!body.d.Message) {
      logger.error(`[Cron][Bank Transactions] Body response missing 'Message': ${JSON.stringify(body)}`)
      return
    }

    const message = body.d.Message
    const messageJson = JSON.parse(message)

    // dùng queue để tránh mất item trong quá trình xử lý
    const queued: Array<{ message: string, date: Date, trace: string, amounts: number[], uniqueCode: string }> = []
    let shouldStop = false
    for (const msgList of Object.values(messageJson) as any[][]) {
      for (const msg of msgList) {
        const fullMessage = `${bank.id} - ${bank.name} ${msg}`
        logger.info(`fullMessage: ${fullMessage}`)

        const evalResult = evaluateMessage(fullMessage, latestDateTransfer, latestTraceId, logger)
        if (evalResult.action === 'stop') {
          shouldStop = true
          break
        }
        if (evalResult.action === 'queue' && evalResult.payload) {
          queued.push(evalResult.payload)
        }
        // skip => continue
      }
      if (shouldStop)
        break
    }

    // Insert from oldest to newest so that checkpoints never jump ahead
    queued.sort((a, b) => a.date.getTime() - b.date.getTime())

    // Xử lý cho topup wallet (user đã đăng ký)
    // for (const item of queued) {
    //   await insertTopupIfValid(item, usersService, topupWalletService, logger)
    // }
    console.log('queue', queued)
    // Xử lý cho purchase histories (checkout without login)
    console.log('purchase_pending', pendingPurchases)
    if (queued.length > 0 && pendingPurchases && purchaseHistoryService && usersService) {
      await processPurchaseMatches(queued, pendingPurchases, purchaseHistoryService, usersService, database, logger)
    }
  }
  catch (error) {
    logger.error(`[Cron][Bank Transactions] Error reading messages from VPBank: ${String(error)}`)
  }
}

export function evaluateMessage(message: string, latestDateTransfer: string | undefined, latestTraceId: string | undefined, _logger: any) {
  const dateStr = extractDate(message)
  const dateObj = parseVnDateToDate(dateStr)
  const amounts = extractAmounts(message)
  const trace = extractTraceNumber(message)
  const uniqueCode = extractUniqueCode(message)

  if (!dateObj)
    return { action: 'skip' as const }

  if (latestDateTransfer) {
    const msgMs = dateObj.getTime()
    const latestMs = Date.parse(latestDateTransfer)
    if (latestMs > 0 && msgMs <= latestMs)
      return { action: 'stop' as const }
  }

  if (latestTraceId && trace === latestTraceId)
    return { action: 'stop' as const }

  if (!uniqueCode)
    return { action: 'skip' as const }

  if (!amounts || amounts.length < 2)
    return { action: 'skip' as const }

  return {
    action: 'queue' as const,
    payload: { message, date: dateObj, trace, amounts, uniqueCode },
  }
}

export function extractDate(text: string): string {
  const match = text.match(/\b\d{2}\/\d{2}\/\d{4}(?:\s+\d{1,2}:\d{2})?\b/)
  return match ? match[0] : ''
}

export function extractAmounts(text: string): number[] {
  const matches = text.match(/(?<!\d)([+-]?)(\d+)VND\b/g)
  if (!matches) {
    return []
  }
  return matches.map((match) => {
    const fullMatch = match.match(/([+-]?)(\d+)VND/)
    if (!fullMatch)
      return 0

    const sign = fullMatch[1] || ''
    const amount = Number.parseInt(fullMatch[2] || '0')
    return sign === '-' ? -amount : amount
  })
}

export function extractTraceNumber(text: string): string {
  const match = text.match(/TRACE\s+(\d+)/)
  return match ? `${match[1]}` : ''
}

export function extractUniqueCode(text: string): string {
  // Lấy text đằng sau "ND"
  // Format: VPB:15/09/2025 16:29|XXXXXX5458|5500VND|00000VND|NHAN TU 0986587205 TRACE 363895 ND abcdef
  const match = text.match(/ND\s+([A-Za-z0-9]+)$/)
  return match ? `${match[1]}` : ''
}

export function parseVnDateToDate(text: string): Date | null {
  // Expect dd/mm/yyyy or dd/mm/yyyy hh:mm format (Vietnam timezone UTC+7)
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (!match)
    return null
  const [_, dd, mm, yyyy, hh, min] = match
  const day = Number.parseInt(dd || '0')
  const month = Number.parseInt(mm || '0') - 1
  const year = Number.parseInt(yyyy || '0')
  const hour = hh ? Number.parseInt(hh) : 0
  const minute = min ? Number.parseInt(min) : 0

  // Create date in Vietnam timezone (UTC+7)
  const vnDate = new Date(year, month, day, hour, minute, 0, 0)

  // Convert to UTC by subtracting 7 hours
  const utcDate = new Date(vnDate.getTime() - (7 * 60 * 60 * 1000))

  return utcDate
}

async function processPurchaseMatches(
  queued: Array<{ message: string, date: Date, trace: string, amounts: number[], uniqueCode: string }>,
  pendingPurchases: PurchaseHistories[],
  purchaseHistoryService: ItemsService<PurchaseHistories>,
  usersService: ItemsService<DirectusUsers>,
  database: any,
  logger: any,
) {
  try {
    logger.info(`[Cron][Purchase Matches] Processing ${queued.length} transactions against ${pendingPurchases.length} pending purchases`)

    for (const transaction of queued) {
      // Tìm purchase_histories có transfer_code khớp với uniqueCode từ giao dịch
      const matchingPurchase = pendingPurchases.find(purchase =>
        purchase.transfer_code === transaction.uniqueCode,
      )

      if (matchingPurchase) {
        logger.info(`[Cron][Purchase Matches] Found matching purchase for code: ${transaction.uniqueCode}`)

        // Kiểm tra số tiền có khớp không
        const transactionAmount = transaction.amounts[0] // Số tiền giao dịch
        const expectedAmount = matchingPurchase.amount || 0
        if (Number(transactionAmount) !== Number(expectedAmount)) {
          logger.error(`[Cron][Purchase Matches] Transaction amount: ${transactionAmount}, Expected: ${expectedAmount}`)
          continue
        }

        const cycle = (matchingPurchase as any).billing_cycle || (expectedAmount > 500000 ? 12 : 1)
        const endDate = calculateEndDate(new Date(), cycle)

        // Cập nhật status của đơn hàng
        await purchaseHistoryService.updateOne(matchingPurchase.id, {
          status: 'published',
          date_transfer: transaction.date.toISOString(),
        })
        logger.info(`[Cron][Purchase Matches] Updated purchase_histories ${matchingPurchase.id} to published status`)

        // Đồng bộ VIP sang bảng users
        const customerId = typeof matchingPurchase.user === 'object' ? matchingPurchase.user?.id : matchingPurchase.user
        if (customerId) {
          await usersService.updateOne(customerId, {
            is_premium: true,
            premium_until: endDate,
            subscription_type: matchingPurchase.type || 'pro',
          })
          logger.info(`[Cron][Purchase Matches] Activated VIP for user ${customerId} until ${endDate}`)

          // Cập nhật policies cho user trong bảng directus_access
          if (database) {
            try {
              // Xoá các policy cũ (customer, Free Access) của user này
              await database('directus_access')
                .where({ user: customerId })
                .whereIn('policy', [
                  '63d26c02-9e8d-4ff6-b89e-87d8a5504da2', // customer policy
                  'bb4a6f63-4b7c-4816-b44f-56aa5dd23033'  // Free Access policy
                ])
                .delete()

              // Thêm policy Premium Access
              const existingPremium = await database('directus_access')
                .where({
                  user: customerId,
                  policy: '8881ead6-d324-4a2a-82b1-3867c1314422' // Premium Access policy
                })
                .first()

              if (!existingPremium) {
                await database('directus_access').insert({
                  user: customerId,
                  policy: '8881ead6-d324-4a2a-82b1-3867c1314422'
                })
                logger.info(`[Cron][Purchase Matches] Assigned Premium Access policy to user ${customerId}`)
              }
            }
            catch (policyErr: any) {
              logger.error(`[Cron][Purchase Matches] Failed to update access policy for user ${customerId}: ${String(policyErr)}`)
            }
          }
        }
      }
    }
  }
  catch (error) {
    logger.error(`[Cron][Purchase Matches] Error processing purchase matches: ${String(error)}`)
  }
}

function calculateEndDate(startDate: Date, billingCycle: string | number): string {
  const months = typeof billingCycle === 'string' ? Number.parseInt(billingCycle) : billingCycle
  const endDate = new Date(startDate)
  endDate.setMonth(endDate.getMonth() + months)
  return endDate.toISOString()
}
