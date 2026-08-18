import { useEffect, useRef, useState } from "react";
import { searchAddress, type GeocodeResult } from "../api/geocoding";

interface Props {
  onSelect: (result: GeocodeResult) => void;
}

export default function AddressSearch({ onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.trim().length < 4) {
      setResults([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        setResults(await searchAddress(query));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function handleSelect(result: GeocodeResult) {
    setQuery(result.placeName);
    setResults([]);
    onSelect(result);
  }

  return (
    <div className="address-search">
      <input
        type="text"
        placeholder="Enter your home or work address…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {loading && <p className="muted small">Searching…</p>}
      {error && <p className="error small">{error}</p>}
      {results.length > 0 && (
        <ul className="address-results">
          {results.map((r) => (
            <li key={`${r.lng},${r.lat}`}>
              <button onClick={() => handleSelect(r)}>{r.placeName}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
