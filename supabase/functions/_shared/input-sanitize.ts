/**
 * input-sanitize.ts — shared server-side text validation
 *
 * Closes the stored-XSS gap found in the PrimeConnect pentest report:
 * update-profile / create-profile / save-store-settings were trimming
 * and length-limiting user text but never rejecting HTML/script-injection
 * characters, so a name or store field could store `<script>...</script>`
 * or similar payloads. Output-side escaping (esc()) already exists and is
 * used consistently across the admin panel and dashboards — this closes
 * the write-side gap as defense in depth, so a payload can never be
 * *stored* in the first place, not just relying on every future render
 * path remembering to escape it.
 *
 * Two validators, for two different kinds of free text:
 *
 *  - validateName(): for person names (first/last/full name). Names can
 *    legitimately contain apostrophes and hyphens (O'Brien, Mensah-Bonsu),
 *    so this allows letters (incl. accented), spaces, hyphens, apostrophes,
 *    and periods — and rejects everything else, including digits.
 *
 *  - rejectUnsafeChars(): for freer-form text (store name, description)
 *    where legitimate values may contain digits, ampersands, etc. This
 *    only rejects the specific characters that enable HTML/script
 *    injection: < > " ; and backtick.
 *
 * Both return `null` when the value is fine, or a user-facing error
 * string when it should be rejected. Callers should return 400 with
 * that message rather than silently stripping characters — silent
 * stripping can mangle legitimate input in confusing ways.
 */

const UNSAFE_CHARS = /[<>";`]/;

export function rejectUnsafeChars(value: string, fieldLabel: string): string | null {
  if (value && UNSAFE_CHARS.test(value)) {
    return `${fieldLabel} contains characters that aren't allowed (< > " ; \`)`;
  }
  return null;
}

// Letters (any language), spaces, hyphens, apostrophes, periods only.
const NAME_PATTERN = /^[\p{L}\s'\-.]*$/u;

export function validateName(value: string, fieldLabel: string): string | null {
  if (value && !NAME_PATTERN.test(value)) {
    return `${fieldLabel} can only contain letters, spaces, hyphens, apostrophes, and periods`;
  }
  return null;
}
