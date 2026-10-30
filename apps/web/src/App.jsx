import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import TopBar from "./components/TopBar.jsx";
import Footer from "./components/Footer.jsx";
import Home from "./pages/Home.jsx";
import Search from "./pages/Search.jsx";
import EventDetail from "./pages/EventDetail.jsx";
import NotFound from "./pages/NotFound.jsx";
import Login from "./pages/Login.jsx";
import Verify from "./pages/Verify.jsx";
import Checkout from "./pages/Checkout.jsx";
import ActiveOrderBanner from "./components/ActiveOrderBanner.jsx";

export default function App() {
  const { pathname } = useLocation();
  useEffect(() => window.scrollTo(0, 0), [pathname]);
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-bg-primary focus:px-4 focus:py-2">
        Skip to content
      </a>
      <TopBar />
      <ActiveOrderBanner />
      <main id="main" className="min-h-[70vh]">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/search" element={<Search />} />
          <Route path="/events/:slug" element={<EventDetail />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Login mode="register" />} />
          <Route path="/verify" element={<Verify />} />
          <Route path="/checkout/:id" element={<Checkout />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </>
  );
}
