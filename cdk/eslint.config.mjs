// ESLint flat config for the CDK infrastructure project (ADR-008).
// Standalone from the Next.js application's ESLint config.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["cdk.out/", "node_modules/", "**/*.js", "**/*.d.ts"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
