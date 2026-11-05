#!/usr/bin/env node
// Regenerates the two generated blocks in index.html. Run this after adding a new
// tw-* class or a new Font Awesome icon:
//
//     node tools/build.mjs
//
// 1. Tailwind: compiles only the tw-* classes the page uses (replaces the CDN compiler).
//    It stays AFTER the hand-written <style>, the same cascade order the CDN produced.
// 2. Icons: cuts Font Awesome down to the icons the page uses, into fonts/fa-*.woff2.
//
// Dependencies install into the OS temp folder, never into this project, so there is
// no node_modules here to get uploaded by accident when deploying the folder.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'index.html');
const FA_VERSION = '7.0.0';
const FA_CDN = `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/${FA_VERSION}`;

// ---------- dependencies ----------
const DEPS = ['tailwindcss@3.4.16', 'postcss@8', 'esbuild@0.25', 'subset-font@2'];
const depDir = path.join(os.tmpdir(), 'portfolio-build');
fs.mkdirSync(depDir, { recursive: true });
if (!fs.existsSync(path.join(depDir, 'node_modules/tailwindcss'))) {
    console.log('Installing build tools (first run only)...');
    execSync(`npm i --no-save --silent --prefix "${depDir}" ${DEPS.join(' ')}`, { stdio: 'inherit' });
}
const require = createRequire(path.join(depDir, 'index.js'));
const postcss = require('postcss');
const tailwindcss = require('tailwindcss');
const esbuild = require('esbuild');
const subsetFont = require('subset-font');

// ---------- helpers ----------
const block = name => new RegExp(`(<!-- build:${name} -->)[\\s\\S]*?(<!-- /build:${name} -->)`);
const fill = (html, name, body) => {
    if (!block(name).test(html)) throw new Error(`Marker build:${name} not found in index.html`);
    return html.replace(block(name), (_, open, close) => `${open}\n    ${body}\n    ${close}`);
};
const minify = async css => (await esbuild.transform(css, { loader: 'css', minify: true, target: 'chrome100' })).code.trim();
async function fetchCached(url) {
    const file = path.join(depDir, 'fa-' + FA_VERSION + '-' + path.basename(url));
    if (!fs.existsSync(file)) {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    }
    return fs.readFileSync(file);
}

let html = fs.readFileSync(INDEX, 'utf8');
// Scan the page without its generated blocks, so old output can't keep unused rules alive
const source = ['tailwind', 'icons'].reduce((s, n) => s.replace(block(n), ''), html);

// ---------- Tailwind ----------
const tailwindConfig = {
    content: [{ raw: source, extension: 'html' }],
    prefix: 'tw-',
    corePlugins: { preflight: false },
    theme: {
        extend: {
            keyframes: {
                marquee: { to: { transform: 'translateX(-50%)' } },
                sheen: { to: { backgroundPosition: '200% center' } },
                blob: { '0%,100%': { transform: 'translate(0,0) scale(1)' }, '50%': { transform: 'translate(4vw,-3vh) scale(1.12)' } }
            },
            animation: {
                marquee: 'marquee 45s linear infinite',
                sheen: 'sheen 6s linear infinite',
                blob: 'blob 18s ease-in-out infinite'
            }
        }
    }
};
const tw = await postcss([tailwindcss(tailwindConfig)])
    .process('@tailwind base;@tailwind components;@tailwind utilities;', { from: undefined });
const twCss = await minify(tw.css);
html = fill(html, 'tailwind', `<style>${twCss}</style>`);

// ---------- Font Awesome subset ----------
const used = { solid: new Set(), regular: new Set(), brands: new Set() };
for (const [, style, icon] of source.matchAll(/\bfa-(solid|regular|brands)\s+(fa-[a-z0-9-]+)/g)) used[style].add(icon);

const faCss = (await fetchCached(`${FA_CDN}/css/all.min.css`)).toString();
const flat = faCss
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
    .replace(/@media[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
    .replace(/@font-face\{[^}]*\}/g, '');

const allIcons = new Set(Object.values(used).flatMap(s => [...s]));
const styleClass = /\.fa-(solid|regular|brands)\b/;
const codepoints = new Map();
const kept = [];
for (const [, selectors, body] of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = selectors.split(',').map(s => s.trim());
    const icons = list.filter(s => allIcons.has(s.slice(1)));
    if (/^(:root|:host)/.test(list[0]) || styleClass.test(selectors)) kept.push(`${selectors}{${body}}`);
    else if (icons.length) {
        const m = body.match(/--fa:"(\\[0-9a-f]+|[^"]+)"/);
        if (!m) throw new Error(`No codepoint for ${icons}`);
        const char = m[1].startsWith('\\') ? String.fromCodePoint(parseInt(m[1].slice(1), 16)) : m[1];
        icons.forEach(i => codepoints.set(i.slice(1), char));
        kept.push(`${icons.join(',')}{${body}}`);
    }
}
const missing = [...allIcons].filter(i => !codepoints.has(i));
if (missing.length) throw new Error(`Unknown Font Awesome icons: ${missing.join(', ')}`);

const fontsDir = path.join(ROOT, 'fonts');
fs.mkdirSync(fontsDir, { recursive: true });
for (const f of fs.readdirSync(fontsDir)) if (/^fa-.*\.woff2$/.test(f)) fs.unlinkSync(path.join(fontsDir, f));

const faces = { solid: ['fa-solid-900', 'Font Awesome 7 Free', 900], regular: ['fa-regular-400', 'Font Awesome 7 Free', 400], brands: ['fa-brands-400', 'Font Awesome 7 Brands', 400] };
const fontFaces = [], preloads = [];
for (const [style, [file, family, weight]] of Object.entries(faces)) {
    const text = [...used[style]].map(i => codepoints.get(i)).join('');
    const out = await subsetFont(await fetchCached(`${FA_CDN}/webfonts/${file}.woff2`), text, { targetFormat: 'woff2' });
    const name = `fa-${style}.${createHash('sha1').update(out).digest('hex').slice(0, 8)}.woff2`;
    fs.writeFileSync(path.join(fontsDir, name), out);
    fontFaces.push(`@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url(fonts/${name}) format("woff2")}`);
    preloads.push(`<link rel="preload" href="fonts/${name}" as="font" type="font/woff2" crossorigin>`);
    console.log(`${name}: ${used[style].size} icons, ${out.length} bytes`);
}
const iconCss = await minify(fontFaces.join('') + kept.join(''));
const license = `/* Font Awesome Free ${FA_VERSION} subset | fontawesome.com/license/free (Icons: CC BY 4.0, Fonts: SIL OFL 1.1, Code: MIT) */`;
html = fill(html, 'icons', `${preloads.join('\n    ')}\n    <style>${license}${iconCss}</style>`);

fs.writeFileSync(INDEX, html);
console.log(`Tailwind: ${twCss.length} bytes, icons CSS: ${iconCss.length} bytes`);
