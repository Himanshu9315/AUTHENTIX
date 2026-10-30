import { useEffect, useState } from "react";
import { api } from "./api.js";

/** Fetches a public path. Pass null to skip. Returns { data, error, loading, reload }. */
export function useFetch(path) {
  const [state, setState] = useState({ data: null, error: null, loading: path !== null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) return;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    api(path, { signal: ctrl.signal })
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error) => error.name !== "AbortError" && setState({ data: null, error, loading: false }));
    return () => ctrl.abort();
  }, [path, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
