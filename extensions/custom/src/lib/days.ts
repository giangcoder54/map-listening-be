/** Days are Vietnam days everywhere (streaks, goals, weekly limits) */
export const TZ = 'Asia/Ho_Chi_Minh';

/** 'YYYY-MM-DD' in Vietnam */
export const vnDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
