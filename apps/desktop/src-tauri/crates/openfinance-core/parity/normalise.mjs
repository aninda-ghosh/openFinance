// Parity normaliser (owned by Wave 0; PLAN.md §3.5). It does exactly four things:
//   1. maps generated ids to placeholders in creation (first-seen) order,
//   2. masks timestamps generated "now",
//   3. ignores object key order,
//   4. drops zod's `details` payload on 400 responses (status and `error` still compared).
// Nothing else is masked. Do not add rules here to make a scenario pass.

/** nanoid() shape: 21 chars of the URL-safe alphabet. */
const ID_RE = /^[A-Za-z0-9_-]{21}$/;
/** new Date().toISOString() shape. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Slack around the run window for "now" timestamps. */
const NOW_SLACK_MS = 60_000;

/**
 * One normaliser per server and scenario. `known` is the set of strings
 * already in the seed database: those are never masked (they are identical in
 * both copies, and masking them could hide a wrong lookup).
 */
export function createNormaliser({ known, runStartedAt }) {
  const ids = new Map();

  function isNow(s) {
    if (!ISO_RE.test(s) || known.has(s)) return false;
    const t = Date.parse(s);
    return t >= runStartedAt - NOW_SLACK_MS && t <= Date.now() + NOW_SLACK_MS;
  }

  function mapString(s) {
    if (isNow(s)) return "<now>";
    // A real nanoid has an uppercase letter, digit or "-" except with odds of
    // (27/64)^21 ≈ 1e-8; requiring one keeps 21-char words such as the key
    // `investment_asset_type` from being masked as ids.
    if (ID_RE.test(s) && /[A-Z0-9-]/.test(s) && !known.has(s)) {
      if (!ids.has(s)) ids.set(s, `<id:${ids.size + 1}>`);
      return ids.get(s);
    }
    return s;
  }

  // Keys are visited in sorted order so placeholder numbering does not
  // depend on key order (rule 3).
  function walk(v) {
    if (typeof v === "string") return mapString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[mapString(k)] = walk(v[k]);
      return out;
    }
    return v;
  }

  /** Normalises a parsed JSON body for a response with `status`. */
  function body(status, json) {
    let v = json;
    if (status === 400 && v && typeof v === "object" && !Array.isArray(v) && "details" in v) {
      v = { ...v };
      delete v.details;
    }
    return walk(v);
  }

  return { body, string: mapString };
}

/** Stable JSON text with sorted keys, for comparing and diffing. */
export function canonical(v) {
  return JSON.stringify(sortKeys(v), null, 2);
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
