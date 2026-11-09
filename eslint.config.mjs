import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Our Link wrapper starts the top loading bar on every tap.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/link.tsx"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "next/link", message: "Import Link from @/components/link so taps show the loading bar." }] }],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "public/maplibre-gl-worker.mjs",
    ],
  },
];

export default eslintConfig;
