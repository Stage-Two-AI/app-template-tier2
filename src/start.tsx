import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "@/App";
import { env } from "@/lib/env";
import { startFoutmelding } from "@/lib/fouten";

// Vóór het renderen, zodat ook een fout bij het opstarten in Sentry komt.
startFoutmelding({ dsn: env.VITE_SENTRY_DSN, omgeving: env.VITE_OMGEVING });

const container = document.getElementById("root");
if (!container) {
  throw new Error("Het element #root ontbreekt in index.html.");
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
