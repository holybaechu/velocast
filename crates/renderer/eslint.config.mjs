import config from "../../eslint.config.mjs";

export default [
  ...config,
  {
    files: ["browser/**/*.js", "browser/**/*.mjs"],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        window: "readonly",
        document: "readonly",
        console: "readonly",
      },
    },
  },
];
