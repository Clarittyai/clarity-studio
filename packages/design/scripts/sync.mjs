#!/usr/bin/env node
/**
 * Pull the design system out of the Clarity platform.
 *
 * Two different jobs, handled two different ways on purpose:
 *
 * 1. **Generated.** The CSS custom properties and the `glass-*` recipes are
 *    lifted verbatim out of `globals.css`. They are pure CSS with no app
 *    coupling, so copying them mechanically is safe and re-runnable.
 *
 * 2. **Asserted.** The Tailwind preset is hand-written, because parsing a
 *    TypeScript config that imports plugins is a fragile way to get a value
 *    you could just read. But a hand-written file drifts silently, so this
 *    script *checks* the load-bearing constants against upstream and fails if
 *    they have moved. `md: 920px` is the one that matters most: it is not
 *    Tailwind's default, and getting it wrong breaks every responsive layout
 *    in a way that looks like a styling mistake rather than a config one.
 *
 * Usage:
 *   node scripts/sync.mjs --source <path-to-clarity-platform> [--check]
 *
 * `--check` writes nothing and exits non-zero on any difference. That is what
 * CI runs.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'src');

/**
 * The ten-layer material needs a component, not just CSS: the layers are ten
 * sibling divs, and without them every `.liquid-glass__*` rule is inert. It
 * lands in the desktop app rather than this package because @clarity-studio/design
 * is deliberately framework-free (CSS + a Tailwind preset, no React).
 */
const COMPONENT_OUT = resolve(HERE, '../../../apps/desktop/src/renderer/components');

const args = process.argv.slice(2);
const check = args.includes('--check');
const sourceArg = args[args.indexOf('--source') + 1];
const SOURCE =
  args.includes('--source') && sourceArg
    ? resolve(sourceArg)
    : resolve(HERE, '../../../vendor/clarity-platform');

/** Constants the hand-written preset depends on. If upstream moves one of
 *  these, the preset is wrong and CI should say so. */
const ASSERTIONS = [
  {
    file: 'tailwind.config.ts',
    what: 'the md breakpoint',
    // Keys may be quoted or bare depending on how the file has been formatted.
    pattern: /['"]?md['"]?\s*:\s*['"]920px['"]/,
    why: "Studio's preset hard-codes md: 920px. Tailwind's default is 768px.",
  },
  {
    file: 'src/app/globals.css',
    what: 'the accent colour',
    pattern: /--accent:\s*227\s+100%\s+68%/,  // an HSL triplet, not a hex
    why: 'The accent (#5B7FFF) is the one brand colour the whole UI leans on.',
  },
  {
    file: 'tailwind.config.ts',
    what: 'hoverOnlyWhenSupported',
    pattern: /['"]?hoverOnlyWhenSupported['"]?\s*:\s*true/,
    why: 'Without it, hover styles stick after a tap on touch devices.',
  },
];

function read(relative) {
  const path = join(SOURCE, relative);
  if (!existsSync(path)) {
    console.error(
      `\nCannot find ${relative} under ${SOURCE}.\n` +
        `  Point at a clarity-platform checkout:\n` +
        `    node scripts/sync.mjs --source ../clarity-platform\n`,
    );
    process.exit(2);
  }
  return readFileSync(path, 'utf8');
}

/** Everything between `selector {` and its matching close brace. */
function block(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Every rule whose selector mentions `glass`, in source order.
 *
 * Deliberately selector-shaped rather than class-shaped. The earlier version
 * only matched a bare `.glass-foo` (optionally followed by more bare classes),
 * which silently dropped three kinds of rule that carry the recipe:
 *
 *   .glass-material::before, .glass-card::before, …   the 155° edge hairline
 *   .dark .glass-card-elevated                        the dark-mode variant
 *   .liquid-glass__material > .lg-edge-reflection     the ten-layer material
 *
 * Silently is the problem: Studio would take the fill and the blur but not the
 * edge, and look almost right. A partial copy is exactly the drift this script
 * exists to prevent.
 *
 * The ten-layer `.liquid-glass*` rules come across too. Studio has no
 * <LiquidGlass> component yet, so they are inert — but they are part of the
 * recipe, and shipping them means the day Studio grows one, the material is
 * already correct rather than half-copied.
 */
function glassRules(css) {
  const out = [];
  const seen = new Set();

  // Media-wrapped rules first, and taken WHOLE. Two of them carry real
  // behaviour: `.lg-sheet` flips a sheet's bottom corners back at the md
  // breakpoint, and `prefers-reduced-transparency` drops the ten-layer stack
  // for users who ask for it. Both live inside `@media`, so a selector-only
  // pass silently loses them — and losing the second one is an accessibility
  // regression, not a cosmetic one.
  const consumed = []; // [start, end) source ranges already taken by a @media
  const media = /^[ \t]*(@media[^{]+)\{/gm;
  let m;
  while ((m = media.exec(css)) !== null) {
    const rule = block(css, m[1].trim());
    if (!rule) continue;
    if (!/glass|\.lg-/i.test(rule)) continue;
    if (seen.has(rule)) continue;
    seen.add(rule);
    const start = css.indexOf(rule);
    consumed.push([start, start + rule.length]);
    out.push({ at: m.index, text: rule.trim() });
  }

  // Then plain rules. A selector list at the start of a line, ending in `{`;
  // selectors may hold classes, descendants, `>` combinators and pseudo-
  // elements. `.lg-*` counts as glass — those are the material's layers.
  const re = /^[ \t]*([.#:a-zA-Z][^{}\n;]*?)\s*\{/gm;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim();
    if (selector.startsWith('@')) continue;
    if (!/glass/i.test(selector) && !/(^|[\s,>])\.lg-/.test(selector)) continue;
    if (seen.has(selector)) continue;
    // Skip only rules that physically sit INSIDE a @media block already taken.
    // Matching on selector text would wrongly drop the base `.lg-sheet` rule,
    // whose selector also appears inside the md override.
    if (consumed.some(([s, e]) => m.index >= s && m.index < e)) continue;
    seen.add(selector);
    const rule = block(css, selector);
    if (rule) out.push({ at: m.index, text: rule.trim() });
  }

  return out.sort((a, b) => a.at - b.at).map((r) => r.text);
}

const globals = read('src/app/globals.css');
const config = read('tailwind.config.ts');

// ── assertions ───────────────────────────────────────────────────────────────
const drifted = ASSERTIONS.filter((a) => !a.pattern.test(a.file.endsWith('.css') ? globals : config));
if (drifted.length > 0) {
  console.error('\nUpstream design values have moved:\n');
  for (const d of drifted) console.error(`  ✘ ${d.what} (${d.file})\n    ${d.why}`);
  console.error('\nUpdate src/tailwind-preset.ts to match, then re-run.\n');
  process.exit(1);
}

// ── tokens.css ───────────────────────────────────────────────────────────────
const root = block(globals, ':root');
const dark = block(globals, '.dark');
if (!root || !dark) {
  console.error('Could not find the :root / .dark token blocks in globals.css.');
  process.exit(2);
}

const header = (name) => `/* ${name} — GENERATED by scripts/sync.mjs. Do not edit.
 *
 * Lifted from clarity-platform so Studio and the platform cannot drift apart.
 * Re-run: pnpm design:sync --source <path-to-clarity-platform>
 */\n\n`;

const tokensCss = header('tokens.css') + `${root}\n\n${dark}\n`;

// ── glass.css ────────────────────────────────────────────────────────────────
const rules = glassRules(globals);
if (rules.length === 0) {
  console.error('Found no .glass-* rules in globals.css — has the recipe been renamed?');
  process.exit(2);
}
const glassCss =
  header('glass.css') +
  '/* The house surface. Floating panels use these; flat opaque fills are the\n' +
  ' * anti-pattern they exist to prevent. */\n\n' +
  rules.join('\n\n') +
  '\n';

// ── liquid-glass.tsx ─────────────────────────────────────────────────────────
// The CSS alone renders nothing: `.liquid-glass__material > .lg-*` needs the
// ten sibling divs this component emits. Copying it keeps the DOM shape and the
// stylesheet in lockstep — a hand-written copy would drift the moment a layer
// is added upstream, and the failure mode is a silently half-rendered material.
const componentSrc = read('src/components/ui/liquid-glass.tsx');

const componentTsx =
  `/* liquid-glass.tsx — GENERATED by scripts/sync.mjs. Do not edit.\n` +
  ` *\n` +
  ` * Lifted from clarity-platform so the ten-layer material and the CSS in\n` +
  ` * @clarity-studio/design/glass.css can never disagree about the DOM shape.\n` +
  ` * Re-run: pnpm design:sync --source <path-to-clarity-platform>\n` +
  ` */\n\n` +
  componentSrc
    // Next.js directive; meaningless in Electron's renderer.
    .replace(/^'use client';\n\n?/, '')
    // The platform's path alias does not exist here; `cn` is a local helper.
    .replace(/from '@\/lib\/utils'/, "from './ui.js'");

if (!/liquid-glass__material/.test(componentTsx) || !/MATERIAL_LAYERS/.test(componentTsx)) {
  console.error('The upstream LiquidGlass component no longer looks like itself.');
  process.exit(2);
}
if (/@\//.test(componentTsx)) {
  console.error('Unrewritten `@/` path alias in the copied component — Studio cannot resolve it.');
  process.exit(2);
}

// ── write or check ───────────────────────────────────────────────────────────
const outputs = [
  ['tokens.css', tokensCss, OUT],
  ['glass.css', glassCss, OUT],
  ['liquid-glass.tsx', componentTsx, COMPONENT_OUT],
];

let changed = 0;
for (const [name, content, dir] of outputs) {
  const path = join(dir, name);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current === content) {
    console.log(`  = ${name} (unchanged)`);
    continue;
  }
  changed++;
  if (check) {
    console.error(`  ✘ ${name} is out of date`);
  } else {
    writeFileSync(path, content, 'utf8');
    console.log(`  ✓ ${name} (${content.split('\n').length} lines)`);
  }
}

if (check && changed > 0) {
  console.error('\nRun `pnpm design:sync` and commit the result.\n');
  process.exit(1);
}

console.log(`\n${rules.length} glass rule(s), ${ASSERTIONS.length} assertion(s) verified.\n`);
