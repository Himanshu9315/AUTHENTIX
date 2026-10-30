import { useEffect, useState } from "react";
import { getSession, logout as apiLogout, onSession } from "./lib/api.js";
import * as queue from "./lib/queue.js";
import Login from "./screens/Login.jsx";
import Scan from "./screens/Scan.jsx";
import Setup from "./screens/Setup.jsx";

const read = () => {
  try {
    return JSON.parse(sessionStorage.getItem("gate-choice"));
  } catch {
    return null;
  }
};

// QR tokens waiting to be sent must not outlive the shift.
const logout = () => {
  queue.clear();
  apiLogout();
};

export default function App() {
  const [session, setSession] = useState(getSession());
  const [choice, setChoice] = useState(read()); // { event: { id, title, startsAt }, gateId }
  useEffect(() => onSession(setSession), []);
  useEffect(() => {
    queue.purgeExpired(); // leftovers from a tab that was closed mid-queue
    return onSession((sess) => !sess && queue.clear()); // the server ended the session
  }, []);
  const choose = (c) => {
    setChoice(c);
    try {
      if (c) sessionStorage.setItem("gate-choice", JSON.stringify(c));
      else sessionStorage.removeItem("gate-choice");
    } catch {}
  };

  if (!session) return <Login />;
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-bg-primary focus:px-3 focus:py-2">Skip to content</a>
      <main id="main" className="mx-auto min-h-screen max-w-md">
        {choice ? <Scan event={choice.event} gateId={choice.gateId} onChange={() => choose(null)} onLogout={logout} /> : <Setup user={session.user} onStart={choose} onLogout={logout} />}
      </main>
    </>
  );
}
