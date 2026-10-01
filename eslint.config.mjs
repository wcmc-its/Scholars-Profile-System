// eslint-config-next 16 ships native flat configs, so the FlatCompat shim
// (`compat.extends("next/core-web-vitals", "next/typescript")`) is gone.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // eslint-config-next 16 pulls in eslint-plugin-react-hooks 7, whose
    // recommended preset adds React Compiler diagnostics. This app does not
    // enable the React Compiler (`reactCompiler` is unset in next.config.ts),
    // and on the Next 16 upgrade these rules flagged 78 pre-existing sites
    // (set-state-in-effect 53, refs 11, purity 9, preserve-manual-memoization
    // 2, immutability 2, globals 1) that lint clean under the Next 15 ruleset.
    // Off here so the framework upgrade does not also become a 78-site
    // refactor; `rules-of-hooks` and `exhaustive-deps` stay on as before.
    // Re-enable (and fix) as a separate change.
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/immutability": "off",
      "react-hooks/globals": "off",
    },
  },
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
