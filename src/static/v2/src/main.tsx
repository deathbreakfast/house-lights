import React from "react";
import { createRoot } from "react-dom/client";
import { DrawerProvider } from "./context/DrawerContext";
import { LEDSceneEditor } from "./pages/LEDSceneEditor";

const mount = document.getElementById("root");

if (!mount) {
  throw new Error("Root element not found for LED Scene Editor.");
}

const root = createRoot(mount);
root.render(
  <React.StrictMode>
    <DrawerProvider>
      <LEDSceneEditor />
    </DrawerProvider>
  </React.StrictMode>
);

