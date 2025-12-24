// @ts-nocheck
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

const config = [
    {
        linterOptions: {
            reportUnusedDisableDirectives: true,
        }
    },

    {
        files: ["**/*.{js,mjs,cjs}"],
        ...js.configs.recommended,
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
            'no-unused-vars': 'off',
            'no-console': 'off'
        }
    },

    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: "module"
            },
            globals: {
                ...globals.browser,
                ...globals.serviceworker
            }
        },
        plugins: {
            "@typescript-eslint": tseslint
        },
        rules: {
            ...tseslint.configs.recommended.rules,
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": ["warn", {
                "argsIgnorePattern": "^_",
                "varsIgnorePattern": "^_",
                "caughtErrorsIgnorePattern": "^_"
            }],
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "no-case-declarations": "off"
        }
    },

    {
        ignores: ["dist/**", "dist-demo/**", "node_modules/**", "playwright-report/**", "test-results/**"]
    }
];

export default config;
