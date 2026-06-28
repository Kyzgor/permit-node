#!/usr/bin/env node
/*
 * Codegen guard — regenerates the typescript-axios client from a pinned OpenAPI 3.1.0
 * fixture through the real generate pipeline (the same `openapi-generator-cli` and the
 * same --additional-properties flags as `yarn generate-openapi-client`, with the
 * generator version resolved from openapitools.json), then asserts the output is fully
 * typed. It fails (non-zero) when the generator silently degrades named properties to
 * `any` — which is what happens when the pinned generator cannot model the 3.1 spec.
 *
 * It runs OUTSIDE the ava `test:*` suites: it needs Java and a generator run that does
 * not fit ava's per-test budget, so CI wires it as its own Java-provisioned job
 * (.github/workflows/ci.yaml `codegen-guard`). Run locally with `node scripts/check-codegen.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'src/tests/codegen/fixtures/openapi-3.1.0.json');
const WRAPPER = join(ROOT, 'node_modules/.bin/openapi-generator-cli');

// the exact typescript-axios flags from the generate-openapi-client script (package.json)
const ADDL =
  'useSingleRequestParameter=true,withSeparateModelsAndApi=true,apiPackage=api,modelPackage=types';
// Only these two may retain the known generator-7.x allOf+default residual (a separate,
// narrower mechanism). Any OTHER all-`any` collapse is the regression this guard catches.
const ALLOWED_RESIDUAL = new Set(['derived-role-rule-create.ts', 'derived-role-block-edit.ts']);
const COLLAPSE = /\[key: string\]: any;/;

function fail(msg) {
  console.error('codegen guard FAILED:\n' + msg);
  console.error(
    '\nThe pinned OpenAPI generator cannot type the 3.1.0 spec. ' +
      'openapitools.json must pin a 3.1-native generator (>= 7.12.0).',
  );
  process.exit(1);
}

if (!existsSync(FIXTURE)) fail(`fixture spec not found: ${FIXTURE}`);
if (!existsSync(WRAPPER)) fail(`openapi-generator-cli not found — run \`yarn install\` first: ${WRAPPER}`);

const out = mkdtempSync(join(tmpdir(), 'codegen-guard-'));
try {
  // real pipeline: the wrapper resolves the generator version from openapitools.json (cwd = ROOT)
  execFileSync(
    WRAPPER,
    [
      'generate',
      '-i', FIXTURE,
      '-g', 'typescript-axios',
      '-o', out,
      `--additional-properties=${ADDL}`,
      '--skip-validate-spec',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );

  const typesDir = join(out, 'types');
  const files = existsSync(typesDir) ? readdirSync(typesDir).filter((f) => f.endsWith('.ts')) : [];
  if (files.length < 300) {
    fail(`generator produced only ${files.length} type files (< 300) — generation likely failed`);
  }

  // (a) tree-wide: no type file may collapse to all-`any` except the tracked residual
  const collapsed = files.filter((f) => COLLAPSE.test(readFileSync(join(typesDir, f), 'utf8')));
  const unexpected = collapsed.filter((f) => !ALLOWED_RESIDUAL.has(f));
  if (unexpected.length) {
    fail(
      `${unexpected.length} type file(s) collapsed to all-\`any\` (named properties lost):\n  ` +
        unexpected.slice(0, 12).join('\n  ') +
        (unexpected.length > 12 ? `\n  ... (+${unexpected.length - 12} more)` : ''),
    );
  }

  // (b) canary: RoleCreate must carry named scalar props, not `any`
  const roleCreate = readFileSync(join(typesDir, 'role-create.ts'), 'utf8');
  if (!/'key': string;/.test(roleCreate) || COLLAPSE.test(roleCreate)) {
    fail("canary RoleCreate is not typed: expected `'key': string;` and no `[key: string]: any`");
  }

  console.log(
    `codegen guard OK - ${files.length} type files fully typed ` +
      `(${collapsed.length} known residual: ${collapsed.join(', ') || 'none'})`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
