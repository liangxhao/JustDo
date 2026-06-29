/**
 * RTL/LTR text direction detection.
 * Copied from OpenClaw ui/src/ui/text-direction.ts
 */

const RTL_CHAR_REGEX =
  /\p{Script=Hebrew}|\p{Script=Arabic}|\p{Script=Syriac}|\p{Script=Thaana}|\p{Script=Nko}|\p{Script=Samaritan}|\p{Script=Mandaic}|\p{Script=Adlam}|\p{Script=Phoenician}|\p{Script=Lydian}/u;

export function detectTextDirection(
  text: string | null,
  skipPattern = /[\s\p{P}\p{S}]/u,
): 'rtl' | 'ltr' {
  if (!text) return 'ltr';
  for (const char of text) {
    if (skipPattern.test(char)) continue;
    return RTL_CHAR_REGEX.test(char) ? 'rtl' : 'ltr';
  }
  return 'ltr';
}
