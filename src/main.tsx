import "@/index.css";
import { toonStartfout } from "@/lib/startfout";

// De app zelf staat in start.tsx. Zo vangt dit bestand een fout bij het opstarten op (een
// omgevingsvariabele die niet klopt, bijvoorbeeld een onbekende dienst in VITE_INLOGDIENST)
// en staat die op het scherm, in plaats van een witte pagina.
import("@/start").catch((fout: unknown) => toonStartfout(fout, document.getElementById("root")));
