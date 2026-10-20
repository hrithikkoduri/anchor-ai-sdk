import React from "react";
import { Terminal } from "lucide-react";
import heyo from "../assets/providers/heyo.png";
import e2b from "../assets/providers/e2b.svg";
import docker from "../assets/providers/docker.svg";

const brands = {
  heyo: { label: "Heyo", image: heyo },
  e2b: { label: "E2B", image: e2b },
  docker: { label: "Docker", image: docker },
  local: { label: "Local" },
};

export function ProviderBrand({ id, children }) {
  const brand = brands[id];
  return (
    <span className="provider-brand" data-provider={id}>
      <span className="provider-logo-frame" aria-hidden="true">
        {brand.image ? (
          <img
            className="provider-logo"
            src={brand.image}
            alt=""
            width={24}
            height={24}
          />
        ) : (
          <Terminal className="provider-logo" size={24} aria-hidden="true" />
        )}
      </span>
      <span>{children ?? brand.label}</span>
    </span>
  );
}
