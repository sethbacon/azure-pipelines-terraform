import { RedactedValue } from "../digest-schema";

/**
 * Render a `RedactedValue` as plain display text. The result is ALWAYS meant
 * to be placed into a React text node (`{formatRedactedValue(v)}`), never
 * into an attribute or HTML sink — see the no-dangerouslySetInnerHTML
 * tripwire test. Never returns anything but the already-redacted `json`
 * string or one of the three fixed placeholder strings, so it can never leak
 * a value shape the digest didn't already declare safe.
 */
export function formatRedactedValue(value: RedactedValue): string {
  switch (value.kind) {
    case "value":
      return value.json;
    case "sensitive":
      return "(sensitive)";
    case "unknown":
      return "(known after apply)";
    case "omitted":
      return "(value omitted: too large)";
  }
}
