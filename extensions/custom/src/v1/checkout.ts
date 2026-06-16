import { Router } from 'express';
import axios from 'axios';
import { customAlphabet } from 'nanoid';
import Decimal from 'decimal.js';
import TelegramBot from 'node-telegram-bot-api';

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

let bot: TelegramBot | null = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
}

export interface Subscriptions {
  id?: string;
  customer?: string;
  product?: string;
  free_trial?: boolean;
}

export function getProductPriceByBillingCycle(product: any, billingCycle: string): Decimal {
  const cycle = Number(billingCycle);
  if (cycle === 0) {
    return new Decimal(0);
  }

  const possibleFields = [
    `price_${cycle}_month`,
    `price_${cycle}_months`,
    `price_${cycle}`,
    `base_${cycle}_month_price`,
    `base_${cycle}_months_price`,
  ];

  for (const field of possibleFields) {
    if (product[field] !== undefined && product[field] !== null) {
      return new Decimal(product[field]);
    }
  }

  const basePrice = product.base_1_month_price || product.price_1_month || product.price || 0;
  return new Decimal(basePrice).mul(new Decimal(cycle));
}

export function handleCheckout(router: Router, context: any) {
  router.post('/checkout', async (req: any, res: any) => {
    console.log('Vao day 12345')
    const { services, getSchema, logger } = context;
    const { ItemsService } = services;
    const schema = await getSchema();

    const accountability = req?.accountability || null;

    if (!accountability || !accountability.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
      logger.info(`Checkout request: ${JSON.stringify(req.body)}`);
      const { plan_id, product_id, billing_cycle, manual } = req.body;
      const targetPlanId = plan_id || product_id;
      // Validate required fields
      if (billing_cycle === undefined || billing_cycle === null) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: billing_cycle',
        });
      }

      const userId = accountability.user;
      const userService = new ItemsService('directus_users', {
        schema,
        accountability: { admin: true },
      });
      const user = await userService.readOne(userId, {
        fields: ['email', 'language'],
      });
      const email = user?.email || '';
      const language = user?.language || 'en-US';

      const EXCHANGE_RATE = 25000;
      const targetCurrency = 'vnd';

      // Lấy thông tin plan từ database
      const plansService = new ItemsService('plans', {
        schema,
        accountability: { admin: true },
      });
      const plansList = await plansService.readByQuery({
        filter: {
          _or: [
            { code: { _eq: 'premium' } },
            { code: { _eq: targetPlanId } },
            { id: { _eq: targetPlanId } }
          ],
          status: { _eq: 'published' }
        },
        limit: 1
      });
      const dbPlan = plansList && plansList[0] ? plansList[0] : null;

      if (!dbPlan) {
        return res.status(404).json({
          success: false,
          error: 'Plan not found or not published'
        });
      }

      // Lấy giá của plan từ database
      const planPricesService = new ItemsService('plan_prices', {
        schema,
        accountability: { admin: true },
      });
      const pricesList = await planPricesService.readByQuery({
        filter: {
          plan_id: { _eq: dbPlan.id },
          currency: { _eq: targetCurrency },
          duration_month: { _eq: Number(billing_cycle) },
          status: { _eq: 'published' }
        },
        limit: 1
      });
      const dbPriceData = pricesList && pricesList[0] ? pricesList[0] : null;
      console.log('dbPriceData', dbPriceData);
      if (!dbPriceData || (dbPriceData.total_price === null && dbPriceData.monthly_price === null)) {
        return res.status(400).json({
          success: false,
          error: `Price configuration not found for plan and billing cycle: ${billing_cycle}`
        });
      }

      const totalPrice = dbPriceData.total_price !== null && dbPriceData.total_price !== undefined
        ? Number(dbPriceData.total_price)
        : Number(dbPriceData.monthly_price) * Number(billing_cycle);

      const productData = {
        title: dbPlan.name || 'Upgrade to Pro',
        name: dbPlan.name || 'Pro Plan',
        type: dbPlan.code || 'pro'
      };

      const priceOriginal = totalPrice;
      const pricePaid = totalPrice;
      const promotionData = null;

      // Helper to format currency for logs / telegram notifications
      const formatPrice = (amount: number, curr: string) => {
        if (curr === 'VND') {
          return `${amount.toLocaleString('vi-VN')} VNĐ`;
        }
        return `$${amount.toFixed(2)}`;
      };

      // Kiểm tra nếu pricePaid = 0, tạo luôn record published và subscriptions
      if (pricePaid === 0) {
        const purchaseHistoryData = {
          user: userId,
          amount: Math.round(totalPrice),
          status: 'published',
          payment_method: 'free',
          currency: targetCurrency,
        };

        const purchaseHistoryService = new ItemsService('purchase_histories', {
          schema,
          accountability: { admin: true },
        });

        const purchaseHistory = await purchaseHistoryService.createOne(purchaseHistoryData);

        return res.status(200).json({
          success: true,
          type: 1,
          purchaseHistoryId: purchaseHistory,
          product_id: targetPlanId,
        });
      }

      // Fetch Master Wallet info for banking details
      const masterWalletService = new ItemsService('master_wallet', {
        schema,
        accountability: { admin: true },
      });
      const masterWallet = await masterWalletService.readSingleton({
        fields: ['*'],
      });

      const generateQrBase64 = async (amount: number, addInfo: string) => {
        if (!masterWallet || !masterWallet.bank_account)
          return '';
        const bankId = masterWallet.bank_id || '970432';
        const accountNo = masterWallet.bank_account;
        const amountInVnd = amount;
        const params = new URLSearchParams({
          amount: String(Math.round(amountInVnd)),
          addInfo,
        });
        const vietQrUrl = `https://img.vietqr.io/image/${bankId}-${accountNo}-qr_only.png?${params.toString()}`;
        try {
          const response = await axios.get(vietQrUrl, { responseType: 'arraybuffer' });
          const base64 = Buffer.from(response.data, 'binary').toString('base64');
          return `data:image/png;base64,${base64}`;
        }
        catch (error: any) {
          logger.error('Error fetching VietQR image:', error.message);
          return '';
        }
      };

      // check thanh toán tự động hay thủ công
      if (manual !== true) {
        const futureTime = new Date(Date.now() + 1000 * 60 * 10); // +10 phút
        futureTime.setSeconds(0, 0);
        const now = new Date();
        if (now.getSeconds() !== 0 || now.getMilliseconds() !== 0) {
          futureTime.setMinutes(futureTime.getMinutes() + 1);
        }

        const purchaseHistoryData = {
          user: userId,
          amount: Math.round(pricePaid),
          status: 'pending',
          transfer_code: customAlphabet(alphabet, 11)(),
          payment_method: 'bank_transfer',
          currency: targetCurrency,
        };

        const purchaseHistoryService = new ItemsService('purchase_histories', {
          schema,
          accountability: { admin: true },
        });

        const purchaseHistory = await purchaseHistoryService.createOne(purchaseHistoryData);

        const qrCode = await generateQrBase64(pricePaid, purchaseHistoryData.transfer_code);

        return res.status(200).json({
          success: true,
          type: 2,
          purchaseHistoryId: purchaseHistory,
          code: purchaseHistoryData.transfer_code,
          product_name: productData.title,
          product_id,
          billing_cycle,
          promotion_applied: null,
          price_paid: pricePaid,
          currency: targetCurrency,
          expire_time: futureTime.toISOString(),
          beneficiaryAccountNumber: masterWallet?.bank_account || '',
          beneficiaryAccountName: masterWallet?.bank_account_name || '',
          beneficiaryBankName: masterWallet?.bank_name || '',
          beneficiaryBankCode: masterWallet?.bank_name || '',
          qrCode,
        });
      }

      if (manual === true) {
        const purchaseHistoryData = {
          user: userId,
          amount: Math.round(pricePaid),
          status: 'pending',
          transfer_code: customAlphabet(alphabet, 11)(),
          payment_method: 'manual_bank',
          currency: targetCurrency,
        };

        const purchaseHistoryService = new ItemsService('purchase_histories', {
          schema,
          accountability: { admin: true },
        });

        const purchaseHistory = await purchaseHistoryService.createOne(purchaseHistoryData);

        // Gửi thông báo Telegram
        if (bot) {
          try {
            const groupChatId = process.env.TELEGRAM_GROUP_ID || '-5020831863';
            const message = `🛒 ĐƠN HÀNG MỚI (CÓ ĐĂNG NHẬP) - THANH TOÁN THỦ CÔNG\n\n`
              + `Khách hàng: ${email}\n`
              + `Sản phẩm: ${productData.name || productData.title}\n`
              + `Giá gốc: ${formatPrice(priceOriginal, targetCurrency)}\n`
              + `Giá thanh toán: ${formatPrice(pricePaid, targetCurrency)}\n`
              + `Chu kỳ: ${billing_cycle} tháng\n`
              + `Mã đơn: ${purchaseHistoryData.transfer_code}\n`
              + `Thời gian: ${new Date().toLocaleString('vi-VN')}\n`
              + `Link xử lý: ${process.env.PUBLIC_URL}/admin/content/purchase_histories/${purchaseHistory}`;

            await bot.sendMessage(groupChatId, message);
          }
          catch (telegramError: any) {
            logger.error('Failed to send Telegram notification:', telegramError);
          }
        }

        const qrCode = await generateQrBase64(pricePaid, purchaseHistoryData.transfer_code);

        return res.status(200).json({
          success: true,
          type: 2,
          purchaseHistoryId: purchaseHistory,
          code: purchaseHistoryData.transfer_code,
          product_name: productData.title,
          product_id,
          billing_cycle,
          promotion_applied: null,
          price_paid: pricePaid,
          currency: targetCurrency,
          beneficiaryAccountNumber: masterWallet?.bank_account || '',
          beneficiaryAccountName: masterWallet?.bank_account_name || '',
          beneficiaryBankName: masterWallet?.bank_name || '',
          beneficiaryBankCode: masterWallet?.bank_name || '',
          qrCode,
        });
      }
    }
    catch (error: any) {
      logger.error('Checkout error:', error);
      return res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: error.message || 'Unknown error',
      });
    }
  });
}
