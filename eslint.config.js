// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Run with: npx eslint@9 .
// Self-contained (no plugins), so it needs no node_modules in the repo.

const gjsGlobals = {
    global: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    console: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
};

const rules = {
    // Correctness
    'no-undef': 'error',
    'no-unused-vars': ['error', {args: 'none'}],
    'no-dupe-keys': 'error',
    'no-dupe-class-members': 'error',
    'no-unreachable': 'error',
    'no-constant-condition': ['error', {checkLoops: false}],
    'no-self-assign': 'error',
    'no-shadow-restricted-names': 'error',
    'no-unsafe-finally': 'error',
    'no-unsafe-optional-chaining': 'error',
    'use-isnan': 'error',
    'valid-typeof': 'error',
    'eqeqeq': 'error',
    'no-var': 'error',
    'prefer-const': 'error',
    // Style (matches GNOME Shell's)
    'indent': ['error', 4, {
        SwitchCase: 0,
        // GNOME style: `GObject.registerClass({...},\nclass Foo ... {` isn't indented.
        ignoredNodes: ['CallExpression[callee.object.name="GObject"][callee.property.name="registerClass"] > ClassExpression'],
    }],
    'quotes': ['error', 'single', {avoidEscape: true}],
    'semi': ['error', 'always'],
    'comma-dangle': ['error', 'always-multiline'],
    'object-curly-spacing': ['error', 'never'],
    'arrow-parens': ['error', 'as-needed'],
    'no-trailing-spaces': 'error',
    'eol-last': 'error',
};

export default [
    {
        files: ['extension/**/*.js'],
        languageOptions: {ecmaVersion: 2022, sourceType: 'module', globals: gjsGlobals},
        rules,
    },
    {
        // Evaluated directly by Looking Glass, which provides `Main`.
        files: ['scripts/hot-load.js'],
        languageOptions: {ecmaVersion: 2022, sourceType: 'script', globals: {...gjsGlobals, Main: 'readonly'}},
        rules,
    },
    {
        files: ['eslint.config.js'],
        languageOptions: {ecmaVersion: 2022, sourceType: 'module'},
        rules,
    },
];
