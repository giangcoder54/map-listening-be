export function calculateEndDate(startDate: Date, billingCycle: string | number): string {
  const months = typeof billingCycle === 'string' ? Number.parseInt(billingCycle) : billingCycle;
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + months);
  return endDate.toISOString();
}

export async function activatePremiumForUser(
  customerId: string,
  endDate: string,
  subscriptionType: string,
  usersService: any,
  database: any,
  logger: any
) {
  try {
    await usersService.updateOne(customerId, {
      is_premium: true,
      premium_until: endDate,
      subscription_type: subscriptionType || 'pro',
    });
    logger.info(`[Premium] Activated VIP for user ${customerId} until ${endDate}`);

    if (database) {
      try {
        // Remove old policies
        await database('directus_access')
          .where({ user: customerId })
          .whereIn('policy', [
            '63d26c02-9e8d-4ff6-b89e-87d8a5504da2', // customer policy
            'bb4a6f63-4b7c-4816-b44f-56aa5dd23033'  // Free Access policy
          ])
          .delete();

        // Add Premium Access policy
        const existingPremium = await database('directus_access')
          .where({
            user: customerId,
            policy: '8881ead6-d324-4a2a-82b1-3867c1314422' // Premium Access policy
          })
          .first();

        if (!existingPremium) {
          await database('directus_access').insert({
            user: customerId,
            policy: '8881ead6-d324-4a2a-82b1-3867c1314422'
          });
          logger.info(`[Premium] Assigned Premium Access policy to user ${customerId}`);
        }
      }
      catch (policyErr: any) {
        logger.error(`[Premium] Failed to update access policy for user ${customerId}: ${String(policyErr)}`);
      }
    }
  } catch (error: any) {
    logger.error(`[Premium] Failed to update user VIP status for ${customerId}: ${String(error)}`);
  }
}
