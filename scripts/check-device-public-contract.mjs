import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDevicePublicContract, classifyDevicePublicContractChanges } from './device-public-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'contracts', 'device-public-contract-v1.json');
const current = buildDevicePublicContract();

if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Wrote ${path.relative(root, fixturePath)}`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const result = classifyDevicePublicContractChanges(baseline, current);
console.log(JSON.stringify(result, null, 2));
if (result.counts.breaking > 0) process.exit(1);
