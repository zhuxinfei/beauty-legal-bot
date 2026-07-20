import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildArtifactAndAudit, buildSelectedSourceProof } from './artifact-builder.js';

const [hydratedPath, selectionPath, editorialPath, sourceOutputPath, artifactOutputPath, auditOutputPath] = process.argv.slice(2);
if (![hydratedPath, selectionPath, editorialPath, sourceOutputPath, artifactOutputPath, auditOutputPath].every(Boolean)) {
  throw new Error('Usage: node worker/run-final-artifact.js <hydrated.json> <selection.json> <editorial.json> <source-proof.json> <artifact.json> <audit.json>');
}
if (process.env.ARTIFACT_ONLY !== '1') throw new Error('ARTIFACT_ONLY=1 is required');
const deliveryVariables = [
  'DINGTALK_WEBHOOK_URL',
  'DINGTALK_ACCESS_TOKEN',
  'DINGTALK_SECRET',
  'FEISHU_WEBHOOK_URL',
  'WEBHOOK_URL',
].filter(name => String(process.env[name] || '').trim());
if (deliveryVariables.length > 0) {
  throw new Error(`Artifact-only run refuses delivery configuration: ${deliveryVariables.join(', ')}`);
}

const hydrated = JSON.parse(readFileSync(resolve(hydratedPath), 'utf8'));
const selection = JSON.parse(readFileSync(resolve(selectionPath), 'utf8'));
const editorial = JSON.parse(readFileSync(resolve(editorialPath), 'utf8'));
const sourceProof = buildSelectedSourceProof(hydrated, selection);
if (!sourceProof.proof.pass) {
  throw new Error(`Source-only proof failed: ${sourceProof.proof.failure_codes.join(', ')}`);
}
const { artifact, audit } = buildArtifactAndAudit(sourceProof, editorial);

for (const [path, value] of [
  [sourceOutputPath, sourceProof],
  [artifactOutputPath, artifact],
  [auditOutputPath, audit],
]) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
  source_only: sourceProof.counts,
  artifact: artifact.counts,
  audit_pass: audit.proof.pass,
  delivery_attempted: false,
}, null, 2));
