import { useEffect, useState } from "react";
import { api } from "./api.js";

/** Fetches a catalog path. Pass null to skip. Returns { data, error, loading }. */
export function useFetch(path) {
  const [state, setState] = useState({ data: null, error: null, loading: path !== null });
  useEffect(() => {
    if (path === null) return;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    api(path, { signal: ctrl.signal })
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error) => error.name !== "AbortError" && setState({ data: null, error, loading: false }));
    return () => ctrl.abort();
  }, [path]);
  return state;
}
