import { env } from "./env.js";

const cache = new Map<string, string | null>();
let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;

interface ReverseResult {
  display_name?: string;
  address?: Record<string, string>;
}

/** "Herrengasse 16, 8010 Graz" from a reverse-geocoding answer; null when it names nothing. */
export function placeLabel(result: ReverseResult): string | null {
  const a = result.address;
  if (!a) {
    return result.display_name?.split(",").slice(0, 3).join(",").trim() || null;
  }
  const street = [a.road ?? a.pedestrian ?? a.footway ?? a.path, a.house_number]
    .filter(Boolean)
    .join(" ");
  const town = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet ?? a.county;
  const place = [a.postcode, town].filter(Boolean).join(" ");
  return [street, place].filter(Boolean).join(", ") || null;
}

/**
 * The address of a position, when the server has a geocoder (`GEOCODER_URL`). Calls go out one
 * at a time and at most one a second — what a public Nominatim asks of its users.
 */
export function reverseGeocode(lat: number, lng: number, language = "en"): Promise<string | null> {
  if (!env.geocoderUrl) {
    return Promise.resolve(null);
  }
  // ~10 m: the same spot asked twice is one call.
  const key = `${lat.toFixed(4)},${lng.toFixed(4)},${language}`;
  if (cache.has(key)) {
    return Promise.resolve(cache.get(key) ?? null);
  }
  const call = queue.then(async () => {
    await new Promise((r) => setTimeout(r, Math.max(0, lastCall + 1000 - Date.now())));
    lastCall = Date.now();
    try {
      const url = new URL(env.geocoderUrl);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("lat", String(lat));
      url.searchParams.set("lon", String(lng));
      url.searchParams.set("zoom", "18");
      url.searchParams.set("addressdetails", "1");
      const res = await fetch(url, {
        headers: { "accept-language": language, "user-agent": `engenty-wizards (${env.appUrl})` },
        signal: AbortSignal.timeout(4000),
      });
      const label = res.ok ? placeLabel((await res.json()) as ReverseResult) : null;
      if (cache.size > 500) {
        cache.clear();
      }
      cache.set(key, label);
      return label;
    } catch {
      return null;
    }
  });
  queue = call;
  return call;
}
