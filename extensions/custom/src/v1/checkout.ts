import { Router } from 'express';
import Decimal from 'decimal.js';
import { newPaymentCode } from './paymentCode';
import { getReceivingAccount } from '../lib/sepayBankAccount';
import { addVat, breakdownFromPreTax } from '../lib/vat';
import { calculateEndDate, activatePremiumForUser } from '../utils';

export function handleCheckout(router: Router, context: any) {
  router.post('/checkout', async (req: any, res: any) => {
    const { services, getSchema, logger, database } = context;
    const { ItemsService } = services;
    const schema = await getSchema();

    const accountability = req?.accountability || null;

    if (!accountability || !accountability.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
      logger.info(`Checkout request: ${JSON.stringify(req.body)}`);

      // SePay giờ tự xác nhận MỌI đơn, không còn nhánh chờ người duyệt. Client cũ còn
      // gửi field `manual` thì bị bỏ qua, vẫn nhận đơn QR như bình thường.
      const { plan_id, product_id, billing_cycle, promotion: promotion_id } = req.body;
      const targetPlanId = plan_id || product_id;

      if (!targetPlanId || billing_cycle === undefined || billing_cycle === null) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: plan_id, billing_cycle',
        });
      }

      const userId = accountability.user;
      const targetCurrency = 'vnd';

      const plansService = new ItemsService('plans', {
        schema,
        accountability: { admin: true },
      });
      // Chỉ lọc theo id khi giá trị đúng dạng UUID. Cột id là kiểu uuid, truyền một
      // chuỗi thường (ví dụ 'premium', giờ FE gửi mã gói thay vì UUID) sẽ làm Postgres
      // ném lỗi cú pháp và cả request checkout hỏng theo.
      const planFilters: any[] = [
        { code: { _eq: 'premium' } },
        { code: { _eq: targetPlanId } },
      ];
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(targetPlanId))) {
        planFilters.push({ id: { _eq: targetPlanId } });
      }

      const plansList = await plansService.readByQuery({
        filter: {
          _or: planFilters,
          status: { _eq: 'published' },
        },
        limit: 1,
      });
      const dbPlan = plansList && plansList[0] ? plansList[0] : null;

      if (!dbPlan) {
        return res.status(404).json({ success: false, error: 'Plan not found or not published' });
      }

      const planPricesService = new ItemsService('plan_prices', {
        schema,
        accountability: { admin: true },
      });
      const pricesList = await planPricesService.readByQuery({
        filter: {
          plan_id: { _eq: dbPlan.id },
          currency: { _eq: targetCurrency },
          duration_month: { _eq: Number(billing_cycle) },
          status: { _eq: 'published' },
        },
        limit: 1,
      });
      const dbPriceData = pricesList && pricesList[0] ? pricesList[0] : null;

      if (!dbPriceData || (dbPriceData.total_price === null && dbPriceData.monthly_price === null)) {
        return res.status(400).json({
          success: false,
          error: `Price configuration not found for plan and billing cycle: ${billing_cycle}`,
        });
      }

      const totalPrice = dbPriceData.total_price !== null && dbPriceData.total_price !== undefined
        ? Number(dbPriceData.total_price)
        : Number(dbPriceData.monthly_price) * Number(billing_cycle);

      let priceOriginal = totalPrice;
      let pricePaid = totalPrice;
      let promotionData: any = null;

      // Áp khuyến mãi nếu có — KHÔNG bắt buộc, hoàn toàn bỏ qua nếu FE không gửi
      // `promotion`. Chưa có UI nhập mã khuyến mãi ở /pricing thì nhánh này chỉ nằm
      // sẵn, không ảnh hưởng gì tới luồng hiện tại.
      if (promotion_id) {
        try {
          const promotionsService = new ItemsService('promotions', {
            schema,
            accountability: { admin: true },
          });
          const promo = await promotionsService.readOne(promotion_id, { fields: ['*'] });
          if (promo && promo.status === 'published') {
            promotionData = promo;
            if (promo.type === 'Percent') {
              pricePaid = new Decimal(totalPrice)
                .mul(new Decimal(1).minus(new Decimal(promo.value).div(100)))
                .toNumber();
            } else if (promo.type === 'Fixed') {
              pricePaid = Decimal.max(new Decimal(0), new Decimal(totalPrice).minus(new Decimal(promo.value))).toNumber();
            }
          }
        } catch (e: any) {
          logger.warn(`Promotion not found or invalid: ${promotion_id}`);
        }
      }

      // Cộng VAT sau khuyến mãi, trước khi tạo đơn và sinh QR — price_original và
      // price_paid cùng đơn vị (đã gồm thuế) nên phần trăm/tiền giảm hiển thị không
      // bị lệch. VAT_RATE mặc định 0 (chưa áp dụng), xem lib/vat.ts.
      priceOriginal = addVat(priceOriginal);
      const paidBreakdown = breakdownFromPreTax(addVat(pricePaid));
      pricePaid = paidBreakdown.total;

      const purchaseHistoryService = new ItemsService('purchase_histories', {
        schema,
        accountability: { admin: true },
      });

      // pricePaid = 0 (khuyến mãi giảm 100%) -> kích hoạt Premium ngay, không cần QR.
      if (pricePaid === 0) {
        const purchaseHistoryData = {
          user: userId,
          plan_id: dbPlan.id,
          billing_cycle: Number(billing_cycle),
          promotion_id: promotionData?.id || null,
          amount: Math.round(totalPrice),
          price_original: Math.round(priceOriginal),
          price_paid: 0,
          price_subtotal: 0,
          vat_rate: 0,
          vat_amount: 0,
          status: 'published',
          payment_method: 'free',
          currency: targetCurrency,
          type: dbPlan.code || 'pro',
        };

        const purchaseHistory = await purchaseHistoryService.createOne(purchaseHistoryData);

        const cycle = Number(billing_cycle) || (totalPrice > 500000 ? 12 : 1);
        const endDate = calculateEndDate(new Date(), cycle);
        const usersService = new ItemsService('directus_users', {
          schema,
          accountability: { admin: true },
        });
        await activatePremiumForUser(userId, endDate, dbPlan.code || 'pro', usersService, database, logger);

        return res.status(200).json({
          success: true,
          type: 1,
          purchaseHistoryId: purchaseHistory,
          product_id: targetPlanId,
        });
      }

      const receivingAccount = await getReceivingAccount(context);

      // Không có tài khoản nhận tiền thì KHÔNG tạo đơn: đơn thiếu QR là đơn không thể
      // trả được, thà báo lỗi ngay ở đây còn hơn để khách thấy modal trống.
      if (!receivingAccount) {
        logger.error('[Checkout] Không có tài khoản nhận tiền — từ chối tạo đơn. Kiểm tra cấu hình master_wallet.');
        return res.status(503).json({
          success: false,
          error: 'Hệ thống thanh toán đang tạm thời không khả dụng, vui lòng thử lại sau ít phút.',
        });
      }

      // QR VietQR động (chỉ trả URL, không tải ảnh về base64): nhanh hơn và không phụ
      // thuộc việc gọi ra ngoài lúc checkout — vietqr.io chậm/sập không còn chặn được
      // việc tạo đơn. `des` chỉ nhận chữ/số không dấu — mã thanh toán GL+8 số đã hợp lệ.
      const buildQrUrl = (amount: number, addInfo: string) => {
        const bank = receivingAccount.bankBin || receivingAccount.bankShortName;
        const acc = receivingAccount.accountNumber;
        const params = new URLSearchParams({
          bank,
          acc,
          amount: String(Math.round(amount)),
          des: addInfo,
        });
        return `https://vietqr.app/img?${params.toString()}&template=&showinfo=0`;
      };

      // 15 phút hết hạn — nếu FE có đồng hồ đếm ngược thì nên khớp giá trị này.
      const futureTime = new Date(Date.now() + 1000 * 60 * 15);
      futureTime.setSeconds(0, 0);
      const expireTime = futureTime.toISOString();

      const purchaseHistoryData = {
        user: userId,
        plan_id: dbPlan.id,
        billing_cycle: Number(billing_cycle),
        promotion_id: promotionData?.id || null,
        amount: Math.round(pricePaid),
        price_original: Math.round(priceOriginal),
        price_subtotal: Math.round(paidBreakdown.subtotal),
        vat_rate: paidBreakdown.vatRate,
        vat_amount: Math.round(paidBreakdown.vatAmount),
        status: 'pending',
        transfer_code: newPaymentCode(),
        expire_time: expireTime,
        payment_method: 'bank_transfer',
        currency: targetCurrency,
        type: dbPlan.code || 'pro',
      };

      const purchaseHistory = await purchaseHistoryService.createOne(purchaseHistoryData);
      const qrCode = buildQrUrl(pricePaid, purchaseHistoryData.transfer_code);

      return res.status(200).json({
        success: true,
        type: 2,
        purchaseHistoryId: purchaseHistory,
        code: purchaseHistoryData.transfer_code,
        product_name: dbPlan.name,
        product_id: targetPlanId,
        billing_cycle,
        promotion_applied: promotionData ? promotionData.title : null,
        price_paid: pricePaid,
        price_subtotal: paidBreakdown.subtotal,
        vat_rate: paidBreakdown.vatRate,
        vat_amount: paidBreakdown.vatAmount,
        currency: targetCurrency,
        expire_time: expireTime,
        beneficiaryAccountNumber: receivingAccount.accountNumber,
        beneficiaryAccountName: receivingAccount.accountHolderName,
        beneficiaryBankName: receivingAccount.bankShortName,
        beneficiaryBankCode: receivingAccount.bankBin,
        qrCode,
      });
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
