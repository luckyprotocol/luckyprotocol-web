import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import LuckyProtocolApp from "./LuckyProtocolApp.jsx";

// Bump on any boot-time issue to force a full reload via vite's
// boundary-detection (changing the entry module is one of the few
// ways to make HMR escalate to a real page reload instead of a
// silent module-swap that leaves a crashed React root behind).
const BOOT_TAG = "v0.1.0";
void BOOT_TAG;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <LuckyProtocolApp />
  </StrictMode>
);
