const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

export interface GeocodeResult {
  placeName: string;
  lng: number;
  lat: number;
}

export async function searchAddress(query: string): Promise<GeocodeResult[]> {
  if (!MAPBOX_TOKEN) {
    throw new Error(
      "VITE_MAPBOX_TOKEN is not set — copy .env.example to .env.local and add a token from https://account.mapbox.com/"
    );
  }
  if (!query.trim()) return [];

  const url = new URL(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`
  );
  url.searchParams.set("access_token", MAPBOX_TOKEN);
  url.searchParams.set("country", "US"); // scope matches Google Solar API coverage, per project scope
  url.searchParams.set("types", "address");
  url.searchParams.set("limit", "5");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Geocoding request failed: ${res.status}`);
  const data = await res.json();

  return (data.features || []).map((f: any) => ({
    placeName: f.place_name as string,
    lng: f.center[0] as number,
    lat: f.center[1] as number,
  }));
}
