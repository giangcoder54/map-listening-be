import { Router } from 'express';

export function handleCheckout(router: Router, context: any) {
  // Status of one of the buyer's own bank orders (learners cannot read purchase_histories):
  // the pricing page asks it every few seconds, 'published' = paid
  router.get('/checkout/:id/status', async (req: any, res: any) => {
    const userId = req.accountability?.user;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const id = String(req.params.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ success: false, error: 'Bad order id' });
    try {
      const row = await context.database('purchase_histories').where({ id, user: userId }).first('status');
      if (!row) return res.status(404).json({ success: false, error: 'Order not found' });
      return res.json({ success: true, status: row.status });
    } catch (error: any) {
      context.logger.error(`[Checkout] Order status ${id}: ${String(error)}`);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });
}
