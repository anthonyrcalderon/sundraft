// OpenStreetMap's Nominatim — free, no API key, no card. Its usage policy
// asks apps to identify themselves via a custom User-Agent or a Referer
// header. Browsers block scripts from setting a custom User-Agent, but the
// Referer that fetch() sends automatically (your site's own URL) satisfies
// that same requirement for client-side apps — no extra header work needed.
// Usage policy: https://operations.osmfoundation.org/policies/nominatim/
// Rate limit: ~1 request/second — comfortably covered by AddressSearch's debounce.

export interface GeocodeResult {
  placeName: string;
  lng: number;
  lat: number;
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

interface NominatimResult {
  display_name: string;
  lon: string;
  lat: string;
}

export async function searchAddress(query: string): Promise<GeocodeResult[]> {
  if (!query.trim()) return [];

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "us"); // matches project scope — see PROJECT-OVERVIEW.md
  url.searchParams.set("limit", "5");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Geocoding request failed: ${res.status}`);
  const data: NominatimResult[] = await res.json();

  return data.map((r) => ({
    placeName: r.display_name,
    lng: parseFloat(r.lon),
    lat: parseFloat(r.lat),
  }));
}

// A short "123 Main Street" name from a full Nominatim display_name like
// "1600, Pennsylvania Avenue Northwest, Washington, District of Columbia,
// 20500, United States" — used to auto-name a still-untitled project once
// its address is set. Nominatim splits the house number into its own
// leading segment for a queried street address, so the street name is
// re-joined from the first two segments; a landmark search (no leading
// number, e.g. "White House, 1600, ...") has nothing to join, so its own
// first segment is used as-is.
export function streetAddressFromPlaceName(placeName: string): string {
  const parts = placeName.split(",").map((s) => s.trim());
  if (parts.length >= 2 && /^\d+[A-Za-z]?$/.test(parts[0])) {
    return `${parts[0]} ${parts[1]}`;
  }
  return parts[0] || placeName;
}
