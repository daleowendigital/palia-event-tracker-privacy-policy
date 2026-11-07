// Produces review artifacts only. No Git writes, credentials, pushes or deployments.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { baselineReport, validateCatalogues } from './validateFishCatalogue.mjs';

const source = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

function isolatedOutput(requested) {
  if (!requested) throw new Error('Candidate directory is required');
  let ancestor = path.resolve(requested);
  const missing = [];
  while (true) {
    try { fs.lstatSync(ancestor); break; } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  // Resolve junctions/symlinks in existing ancestors, including the protected root.
  const canonical = fs.realpathSync.native(ancestor);
  if (!fs.statSync(canonical).isDirectory()) throw new Error('Output ancestor is not a directory');
  const output = path.resolve(canonical, ...missing);
  const relative = path.relative(source, output);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Candidate directory must be outside the working repository');
  }
  return output;
}
const report = { status: 'failed', sourceCommit: process.env.GITHUB_SHA || null };
let reportFile;
try {
  const output = isolatedOutput(process.argv[2]);
  // Use the canonical target, not the alias supplied by the caller. Refuse reuse.
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output);
  reportFile = path.join(output, 'review-report.json');
  const baselineRoot = JSON.parse(fs.readFileSync(path.join(source, 'fish.json'), 'utf8'));
  const checkedInPublic = JSON.parse(fs.readFileSync(path.join(source, 'docs/fish.json'), 'utf8'));
  const publicUrl = 'https://daleowendigital.github.io/palia-event-tracker-privacy-policy/fish.json';
  const response = await fetch(publicUrl, { signal: AbortSignal.timeout(30000), headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`Cannot establish published baseline: HTTP ${response.status}`);
  const baselinePublic = await response.json();
  report.publishedSource = publicUrl;
  report.baselines = baselineReport(baselineRoot, baselinePublic);
  console.log(JSON.stringify(report.baselines, null, 2));
  if (report.baselines.errors.length) throw new Error('Invalid baseline; review required');
  if (JSON.stringify(checkedInPublic) !== JSON.stringify(baselinePublic)) {
    throw new Error('Published catalogue differs from checked-in docs baseline; review required');
  }
  const candidate = path.join(output, 'candidate');
  fs.mkdirSync(candidate);
  fs.mkdirSync(path.join(candidate, 'tools'));
  fs.mkdirSync(path.join(candidate, 'src'));
  fs.mkdirSync(path.join(candidate, 'docs'));
  for (const file of ['pull-fish.mjs', 'tools/enrichFishImages.mjs', 'tools/mirrorFishImages.mjs', 'tools/bumpFishVersion.js']) {
    fs.copyFileSync(path.join(source, file), path.join(candidate, file));
  }
  const images = path.join(source, 'docs/fish-images');
  if (fs.existsSync(images)) {
    fs.mkdirSync(path.join(candidate, 'docs/fish-images'));
    for (const file of fs.readdirSync(images)) {
      if (/\.(png|jpe?g|webp|gif|avif)$/i.test(file) && fs.statSync(path.join(images, file)).isFile()) {
        fs.copyFileSync(path.join(images, file), path.join(candidate, 'docs/fish-images', file));
      }
    }
  }
  for (const script of ['pull-fish.mjs', 'tools/enrichFishImages.mjs', 'tools/mirrorFishImages.mjs', 'tools/bumpFishVersion.js']) {
    const result = spawnSync(process.execPath, [script], { cwd: candidate, stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8', env: process.env });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) {
      report.generationFailure = { script, exitCode: result.status, details: result.stderr || result.error?.message };
      throw new Error(`${script} failed: ${result.error?.message || result.status}`);
    }
  }
  const root = JSON.parse(fs.readFileSync(path.join(candidate, 'fish.json'), 'utf8'));
  const publicCatalogue = JSON.parse(fs.readFileSync(path.join(candidate, 'docs/fish.json'), 'utf8'));
  report.validation = validateCatalogues(root, publicCatalogue, [baselineRoot, baselinePublic]);
  if (!report.validation.valid) throw new Error('Candidate validation failed; no publishable artifact');
  // Report all changes, not just removals, for human review.
  report.changes = { againstRoot: baselineReport(root, baselineRoot), againstPublic: baselineReport(root, baselinePublic) };
  // Export only approved output types and images actually referenced by this candidate.
  const review = path.join(output, 'review');
  for (const file of ['fish.json', 'docs/fish.json', 'src/fishVersion.ts']) {
    fs.mkdirSync(path.dirname(path.join(review, file)), { recursive: true });
    fs.copyFileSync(path.join(candidate, file), path.join(review, file));
  }
  for (const fish of publicCatalogue.fish) {
    if (!fish.imageUrl?.startsWith(publicUrl.replace('/fish.json', '/fish-images/'))) continue;
    const filename = decodeURIComponent(new URL(fish.imageUrl).pathname.split('/').pop());
    if (filename !== path.basename(filename)) throw new Error('Unsafe mirrored image filename');
    fs.mkdirSync(path.join(review, 'docs/fish-images'), { recursive: true });
    fs.copyFileSync(path.join(candidate, 'docs/fish-images', filename), path.join(review, 'docs/fish-images', filename));
  }
  report.status = 'validated-for-review-only';
  console.log('Validated candidate ready for review. Nothing committed or published.');
} catch (error) {
  report.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
}
