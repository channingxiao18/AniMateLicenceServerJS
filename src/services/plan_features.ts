/**
 * Parse and format plan feature lists from admin input or stored JSON.
 */

function cleanFeatureToken(value: unknown): string {
  let text = String(value ?? "").trim();

  for (let i = 0; i < 4; i++) {
    const withoutBrackets = text.replace(/^\[+/, "").replace(/\]+$/, "").trim();
    if (withoutBrackets !== text) {
      text = withoutBrackets;
      continue;
    }

    const quoted =
      (text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'"));
    if (!quoted) break;

    if (text.startsWith('"')) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "string") {
          text = parsed.trim();
          continue;
        }
      } catch {
        // Fall back to trimming simple quotes below.
      }
    }

    text = text.slice(1, -1).trim();
  }

  return text.trim();
}

function featureParts(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;

  const raw = String(value ?? "").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "string" && parsed !== raw) return featureParts(parsed);
  } catch {
    // Human-friendly input is comma/newline separated, not necessarily JSON.
  }

  return raw.split(/[\n,]/);
}

export function parsePlanFeatures(value: unknown): string[] {
  const seen = new Set<string>();
  const features: string[] = [];

  for (const part of featureParts(value)) {
    const feature = cleanFeatureToken(part);
    if (!feature || seen.has(feature)) continue;
    seen.add(feature);
    features.push(feature);
  }

  return features;
}

export function formatPlanFeatures(value: unknown): string {
  return parsePlanFeatures(value).join(", ");
}
