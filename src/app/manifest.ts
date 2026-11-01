import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Løype",
    short_name: "Løype",
    description: "Your adaptive running coach",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0d0c",
    theme_color: "#0b0d0c",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
