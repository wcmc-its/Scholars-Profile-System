import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Test fixtures intentionally render raw <a href="/page"> elements to
    // exercise navigation/guard behavior (e.g. the unsaved-changes
    // beforeunload guard); rewriting them to next/link would defeat the
    // test. The no-html-link-for-pages rule only matters for real pages.
    files: ["tests/**"],
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
      // cdk/ is a standalone CDK project with its own ESLint config (ADR-008).
      "cdk/**",
    ],
  },
];

export default eslintConfig;
