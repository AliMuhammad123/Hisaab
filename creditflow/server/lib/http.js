// Errors, input checks and money handling shared by every route.

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Reads an own property only, so keys inherited from Object.prototype are never picked up. */
export const get = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);

const label = (key) => key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
// Control characters other than tab, newline and carriage return.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Input checks. Each returns the cleaned value or throws a 422 with a message the user can act on. */
export const V = {
  text(input, key, max, required = false, name = '') {
    name ||= label(key);
    let v = get(input, key) ?? '';
    if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
    if (typeof v !== 'string') throw new HttpError(422, `${name} is not valid.`);
    v = v.replace(CONTROL, '').trim();
    if (required && v === '') throw new HttpError(422, `${name} is required.`);
    if ([...v].length > max) throw new HttpError(422, `${name} is too long (max ${max} characters).`);
    return v;
  },

  email(input, key = 'email', required = true) {
    const v = V.text(input, key, 190, required, 'Email').toLowerCase();
    if (v !== '' && !/^[^\s@"<>()[\]\\,;:]+@[^\s@"<>()[\]\\,;:]+\.[^\s@"<>()[\]\\,;:]{2,}$/.test(v)) {
      throw new HttpError(422, 'Enter a valid email address.');
    }
    return v;
  },

  date(input, key, required = true, name = 'Date') {
    const v = get(input, key);
    if (v === undefined || v === null || v === '') {
      if (required) throw new HttpError(422, `${name} is required.`);
      return null;
    }
    if (!isDate(v)) throw new HttpError(422, `${name} is not a valid date.`);
    return v;
  },

  month(v) {
    if (typeof v !== 'string' || !/^20\d\d-(0[1-9]|1[0-2])$/.test(v)) throw new HttpError(422, 'Month is not valid.');
    return v;
  },

  choice(input, key, allowed, name = '') {
    const v = get(input, key);
    if (typeof v !== 'string' || !allowed.includes(v)) throw new HttpError(422, `${name || label(key)} is not valid.`);
    return v;
  },

  id(v, name = 'Item') {
    if ((Number.isSafeInteger(v) && v > 0) || (typeof v === 'string' && /^[1-9]\d{0,15}$/.test(v))) {
      const n = Number(v);
      if (Number.isSafeInteger(n)) return n;
    }
    throw new HttpError(422, `${name} is not valid.`);
  },
};

/** True for a real calendar date written YYYY-MM-DD between 2000 and 2100. */
export function isDate(v) {
  if (typeof v !== 'string' || !/^(\d{4})-(\d{2})-(\d{2})$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Money is handled as whole minor units (cents) so sums never pick up
 * floating-point errors. Amounts travel as numbers with up to two decimals.
 */
export const Money = {
  MAX: 99_999_999_999, // 999,999,999.99

  parse(input, key, name, allowZero = false) {
    let v = get(input, key);
    if (typeof v === 'number') v = Number.isFinite(v) ? String(v) : '';
    if (typeof v !== 'string' || !/^\d{1,12}(\.\d{1,2})?$/.test(v.trim())) {
      throw new HttpError(422, `${name} must be a number, for example 1500 or 1500.50.`);
    }
    const c = Money.fromDb(v.trim());
    if (c > Money.MAX) throw new HttpError(422, `${name} is too large.`);
    if (c === 0 && !allowZero) throw new HttpError(422, `${name} must be more than zero.`);
    return c;
  },

  /** "123.45" (or a DECIMAL from MySQL) to 12345. Never goes through floating point. */
  fromDb(v) {
    if (v === null || v === undefined) return 0;
    let s = typeof v === 'string' ? v.trim() : Number(v).toFixed(2);
    const neg = s.startsWith('-');
    s = s.replace(/^-/, '');
    const [whole, frac = ''] = s.split('.');
    const c = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
    return neg ? -c : c;
  },

  toDb(c) {
    const a = Math.abs(c);
    return `${c < 0 ? '-' : ''}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
  },

  out(c) {
    return Math.round(c) / 100;
  },
};
