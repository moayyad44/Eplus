const ARABIC_DIGITS: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

export const latinDigits = (s: string) => s.replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] ?? d);

/**
 * Normalises phone numbers so the same number always matches:
 * Arabic digits → Latin, strips separators, and converts the Jordan country code (+962/00962) to the local 0 prefix.
 */
export function normalizePhone(input: string): string {
  let s = latinDigits(input).replace(/[^\d+]/g, '');
  if (s.startsWith('+962')) s = '0' + s.slice(4);
  else if (s.startsWith('00962')) s = '0' + s.slice(5);
  else if (s.startsWith('962') && s.length === 12) s = '0' + s.slice(3);
  if (/^7\d{8}$/.test(s)) s = '0' + s;
  return s.replace(/\+/g, '');
}
