import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
    {
        ignores: ["dist/**", "main.js", "node_modules/**"],
    },
    ...obsidianmd.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                project: "./tsconfig.json",
            },
        },
        rules: {
            "no-console": [
                "error",
                { allow: ["warn", "error", "debug"] },
            ],
            "no-restricted-syntax": [
                "error",
                {
                    selector: "TSAnyKeyword",
                    message: "Unexpected any. Specify a different type.",
                },
            ],
        },
    },
];
