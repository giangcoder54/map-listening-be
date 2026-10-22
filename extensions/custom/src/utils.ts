/** billing_cycle / duration_month 0 = lifetime: one payment, Premium never expires */
export const LIFETIME_CYCLE = 0;
export const isLifetimeCycle = (billingCycle: unknown) =>
  billingCycle !== null && billingCycle !== undefined && billingCycle !== '' && Number(billingCycle) === LIFETIME_CYCLE;

/**
 * Months an order buys: its billing_cycle (0 = lifetime is kept, not taken as missing);
 * old orders without one are guessed from the amount.
 */
export const purchaseCycle = (billingCycle: unknown, amount: number) =>
  billingCycle !== null && billingCycle !== undefined && billingCycle !== '' && Number.isFinite(Number(billingCycle))
    ? Number(billingCycle)
    : (amount > 500000 ? 12 : 1);

/** End of the Premium bought; null for lifetime (no end) */
export function calculateEndDate(startDate: Date, billingCycle: string | number): string | null {
  if (isLifetimeCycle(billingCycle)) return null;
  const months = typeof billingCycle === 'string' ? Number.parseInt(billingCycle) : billingCycle;
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + months);
  return endDate.toISOString();
}

/**
 * endDate null = lifetime.
 * `usersService` must be a UsersService (not ItemsService('directus_users')): only it clears
 * Directus' permission cache when the role changes, else the learner's /users/me keeps the
 * old role's fields until the cache expires.
 */
export async function activatePremiumForUser(
  customerId: string,
  endDate: string | null,
  subscriptionType: string,
  usersService: any,
  database: any,
  logger: any
) {
  try {
    // A lifetime user stays lifetime: a later time-limited order must not give them an end date
    let alreadyLifetime = false;
    if (database && endDate) {
      const current = await database('directus_users').select('subscription_type').where('id', customerId).first();
      alreadyLifetime = current?.subscription_type === 'lifetime';
    }
    const lifetime = !endDate || alreadyLifetime;
    let roleUpdateParams: any = {
      is_premium: true,
      premium_until: lifetime ? null : endDate,
      subscription_type: lifetime ? 'lifetime' : (subscriptionType || 'pro'),
    };

    if (database) {
      try {
        const premiumRole = await database('directus_roles')
          .whereRaw("trim(name) = 'Premium User'")
          .first();
        // Only learners move to Premium User: an admin or a content editor keeps their role
        // (is_premium above is what unlocks the lessons)
        const current = await database('directus_users as u')
          .leftJoin('directus_roles as r', 'r.id', 'u.role')
          .where('u.id', customerId)
          .first('r.name as role_name');
        const learner = !current?.role_name || ['Free User', 'Premium User'].includes(String(current.role_name).trim());

        if (premiumRole && premiumRole.id && learner) {
          roleUpdateParams.role = premiumRole.id;
        }
      } catch (err: any) {
        logger.error(`[Premium] Failed to query Premium User role: ${String(err)}`);
      }
    }

    await usersService.updateOne(customerId, roleUpdateParams);
    // Policies come from the role (Premium User = Premium Access + Free Access): no
    // per-user policy rows. Expired users go back to Free User via downgradeExpiredPremium.
    logger.info(`[Premium] Activated VIP for user ${customerId} ${lifetime ? 'for life' : `until ${endDate}`}`);
  } catch (error: any) {
    logger.error(`[Premium] Failed to update user VIP status for ${customerId}: ${String(error)}`);
  }
}
