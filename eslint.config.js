import globals from "globals";
import js from "@eslint/js";

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: {
                ...globals.browser,
                ...globals.serviceworker,
                ...globals.node
            }
        },
        rules: {
            "no-unused-vars": ["warn", {
                "argsIgnorePattern": "^_|e|event",
                "varsIgnorePattern": "^_|e|error",
                "caughtErrorsIgnorePattern": "^_|e|error"
            }],
            "no-console": "off",
            "no-undef": "warn" // Warn but don't error for now as we might have legacy globals
        },
        ignores: ["dist/**", "webpack_config/**", "node_modules/**"]
    }
];
