import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildSourceOnlyAudit } from './content-quality.js';

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  throw new Error('Usage: node worker/run-source-only-audit.js <replay.json> <audit.json>');
}

const replay = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
const audit = buildSourceOnlyAudit(replay);
mkdirSync(dirname(resolve(outputPath)), { recursive: true });
writeFileSync(resolve(outputPath), `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(audit.counts));
console.log(audit.proof.pass ? 'source-only proof passed' : `source-only proof failed: ${audit.proof.failure_codes.join(', ')}`);
