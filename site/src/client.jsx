import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";

export function mountPage(Component) {
  if (typeof document === "undefined") return;
  const root = document.getElementById("root");
  if (root.hasChildNodes()) hydrateRoot(root, <Component />);
  else createRoot(root).render(<Component />);
}
