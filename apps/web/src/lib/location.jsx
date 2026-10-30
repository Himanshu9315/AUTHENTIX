import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api.js";

const LocationContext = createContext(null);
export const useLocationCtx = () => useContext(LocationContext);

const DEFAULT_CITY = "Delhi NCR";
const read = () => {
  try {
    return localStorage.getItem("city");
  } catch {
    return null;
  }
};

/** Holds the chosen city and the coordinates used for "distance from you". */
export function LocationProvider({ children }) {
  const [cities, setCities] = useState([]);
  const [city, setCityState] = useState(read() ?? DEFAULT_CITY);
  const [myCoords, setMyCoords] = useState(null); // only set when the user shares their location

  useEffect(() => {
    api("/cities").then((d) => setCities(d.items)).catch(() => {});
  }, []);

  const setCity = useCallback((c) => {
    setCityState(c);
    setMyCoords(null);
    try {
      localStorage.setItem("city", c);
    } catch {}
  }, []);

  const useMyLocation = useCallback(() => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => setMyCoords({ lat: Number(pos.coords.latitude.toFixed(3)), lng: Number(pos.coords.longitude.toFixed(3)) }),
      () => {},
      { timeout: 8000 },
    );
  }, []);

  const value = useMemo(() => {
    const centre = cities.find((c) => c.city === city);
    const coords = myCoords ?? (centre ? { lat: Number(centre.lat.toFixed(3)), lng: Number(centre.lng.toFixed(3)) } : null);
    return { cities, city, setCity, coords, usingMyLocation: myCoords !== null, useMyLocation };
  }, [cities, city, setCity, myCoords, useMyLocation]);

  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}
