#!/usr/bin/env node
/* Design-token lint.
 *
 * klndr's stylesheets drifted once already, badly: nine border widths for one
 * kind of line, seventeen radii, six slab depths, and --border-thick declared
 * as a 2.5px WIDTH in common.css and a 2.8px SHORTHAND in app.css, so the
 * structural line was a different thickness on login than in the app and no
 * single edit could fix it. Nothing in CSS prevents that happening again, so
 * this does.
 *
 * Run: node scripts/check-design-tokens.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHEETS = [
  'public/css/theme.css',
  'public/css/common.css',
  'public/css/login.css',
  'protected/css/app.css',
  'protected/css/responsive.css',
  'admin/analytics.css'
];

// common.css is where the scale is DEFINED, so it is the one file allowed to
// say a raw number for these.
const SCALE_FILE = 'public/css/common.css';

const RADIUS_OK = /^(var\(--radius-(xs|sm|md|lg|pill)\)|0|50%|calc\(.*\))$/;
const WIDTH_OK = /var\(--(line-(hair|control|container)|border-(control|container|block|hair))\)/;

const failures = [];
const fail = (file, line, msg) => failures.push(`${file}:${line}  ${msg}`);

for (const rel of SHEETS) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // Comments carry prose about the old values; they are documentation, not rules.
  const lines = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n');

  lines.forEach((line, i) => {
    const n = i + 1;

    // --- radii -------------------------------------------------------------
    const radius = line.match(/(?<![-\w])border-radius:\s*([^;]+);/);
    if (radius && rel !== SCALE_FILE) {
      const parts = radius[1].trim().split(/\s+(?![^(]*\))/);
      for (const part of parts) {
        if (!RADIUS_OK.test(part)) {
          fail(rel, n, `radius off the scale: ${radius[1].trim()}`);
          break;
        }
      }
    }

    // --- border widths -----------------------------------------------------
    const border = line.match(/(?<![-\w])border(?:-(?:top|right|bottom|left))?:\s*([^;]+);/);
    if (border && rel !== SCALE_FILE) {
      const v = border[1].trim();
      if (v !== 'none' && !/^0\b/.test(v) && !WIDTH_OK.test(v) && !/^calc\(/.test(v)) {
        fail(rel, n, `border width off the scale: ${v}`);
      }
    }

    // --- shadows -----------------------------------------------------------
    const shadow = line.match(/(?<![-\w])box-shadow:\s*([^;]+);?/);
    if (shadow) {
      const v = shadow[1];
      // a third length on an offset pair is a blur radius
      if (/(?:^|\s)-?[\d.]+px\s+-?[\d.]+px\s+[1-9][\d.]*px/.test(v)) {
        fail(rel, n, `blurred shadow (the house style is a hard slab): ${v.trim()}`);
      }
      if (/rgba\(\s*0\s*,\s*0\s*,\s*0/.test(v)) {
        fail(rel, n, `raw black shadow will not invert in dark: ${v.trim()}`);
      }
    }

    // --- focus -------------------------------------------------------------
    if (/^\s*outline:\s*none;/.test(line)) {
      fail(rel, n, 'bare outline:none removes the focus ring with nothing in its place');
    }
  });
}

// --- the two dark blocks have to stay in step -------------------------------
{
  const src = fs.readFileSync(path.join(ROOT, 'public/css/theme.css'), 'utf8');
  const grab = (start, end) => {
    const a = src.indexOf(start);
    if (a < 0) return null;
    const b = src.indexOf(end, a);
    return src.slice(a + start.length, b);
  };
  const decls = (block) => {
    const out = {};
    const clean = block.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of clean.matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);/g)) {
      out[m[1]] = m[2].trim();
    }
    return out;
  };
  const media = grab(':root:not([data-theme="light"]) {', '\n  }\n');
  const attr = grab('\n:root[data-theme="dark"] {\n', '\n}\n');
  if (media && attr) {
    const a = decls(media), b = decls(attr);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[k] !== b[k]) {
        fail('public/css/theme.css', 0,
          `dark blocks out of step on ${k}: media=${a[k]} attr=${b[k]}`);
      }
    }
  } else {
    fail('public/css/theme.css', 0, 'could not locate both dark blocks');
  }
}

if (failures.length) {
  console.error(`\n${failures.length} design-token violation(s):\n`);
  failures.forEach((f) => console.error('  ' + f));
  console.error('');
  process.exit(1);
}
console.log('design tokens: clean');
