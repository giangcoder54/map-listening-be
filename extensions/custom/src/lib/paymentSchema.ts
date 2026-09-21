/**
 * Đảm bảo schema DB cần cho luồng thanh toán SePay đã sẵn sàng, tự chạy khi Directus
 * load extension (giống ensureLearnersTable ở v1/index.ts) — không cần migration tay.
 * An toàn để chạy lại nhiều lần: mỗi cột/bảng đều kiểm tra tồn tại trước khi tạo.
 */
async function ensureColumn(database: any, table: string, column: string, build: (t: any) => void, logger: any) {
  const exists = await database.schema.hasColumn(table, column);
  if (!exists) {
    await database.schema.alterTable(table, build);
    logger.info(`[Payments] Đã thêm cột ${table}.${column}`);
  }
}

export async function ensurePaymentSchema(database: any, logger: any) {
  try {
    const hasPurchaseHistories = await database.schema.hasTable('purchase_histories');
    if (hasPurchaseHistories) {
      await ensureColumn(database, 'purchase_histories', 'plan_id', (t: any) => t.uuid('plan_id').nullable(), logger);
      await ensureColumn(database, 'purchase_histories', 'billing_cycle', (t: any) => t.integer('billing_cycle').nullable(), logger);
      await ensureColumn(database, 'purchase_histories', 'type', (t: any) => t.string('type', 50).nullable(), logger);
      await ensureColumn(database, 'purchase_histories', 'promotion_id', (t: any) => t.uuid('promotion_id').nullable(), logger);
      await ensureColumn(database, 'purchase_histories', 'price_original', (t: any) => t.integer('price_original').nullable(), logger);
      await ensureColumn(database, 'purchase_histories', 'price_subtotal', (t: any) => t.integer('price_subtotal').nullable(), logger);
      await ensureColumn(database, 'purchase_histories', 'vat_rate', (t: any) => t.decimal('vat_rate', 5, 2).defaultTo(0), logger);
      await ensureColumn(database, 'purchase_histories', 'vat_amount', (t: any) => t.integer('vat_amount').defaultTo(0), logger);
      await ensureColumn(database, 'purchase_histories', 'auto_renew', (t: any) => t.boolean('auto_renew').defaultTo(false), logger);
      await ensureColumn(database, 'purchase_histories', 'expire_time', (t: any) => t.timestamp('expire_time', { useTz: true }).nullable(), logger);
    }

    const hasPromotions = await database.schema.hasTable('promotions');
    if (!hasPromotions) {
      await database.schema.createTable('promotions', (t: any) => {
        t.uuid('id').primary().defaultTo(database.raw('gen_random_uuid()'));
        t.string('code', 50).unique();
        t.string('title', 255);
        t.string('type', 20); // 'Percent' | 'Fixed'
        t.decimal('value', 12, 2);
        t.string('status', 20).defaultTo('published');
        t.timestamp('valid_from', { useTz: true }).nullable();
        t.timestamp('valid_until', { useTz: true }).nullable();
        t.timestamp('date_created', { useTz: true }).defaultTo(database.fn.now());
      });
      logger.info('[Payments] Đã tạo bảng promotions');
    }
  }
  catch (err: any) {
    logger.error(`[Payments] Lỗi khi đảm bảo schema thanh toán: ${String(err)}`);
  }
}
