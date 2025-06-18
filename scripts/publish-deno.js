#!/usr/bin/env node

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const denoJsonPath = path.join(__dirname, '..', 'deno.json');

// Read deno.json
const denoJson = JSON.parse(fs.readFileSync(denoJsonPath, 'utf8'));

// Backup original deno.json
const backupPath = denoJsonPath + '.backup';
fs.writeFileSync(backupPath, JSON.stringify(denoJson, null, 2));

try {
  // Get command line arguments
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  
  // Run deno publish with all passed arguments
  const extraArgs = isDryRun ? '--allow-dirty' : '';
  const publishCommand = `deno publish --no-check --allow-slow-types ${extraArgs} ${args.join(' ')}`;
  console.log(`Running: ${publishCommand}`);
  
  execSync(publishCommand, { stdio: 'inherit' });
  
  console.log(isDryRun ? 'Dry run completed successfully!' : 'Published successfully!');
} catch (error) {
  console.error('Publish failed:', error.message);
  process.exitCode = 1;
} finally {
  // Restore original deno.json
  fs.renameSync(backupPath, denoJsonPath);
  console.log('Restored original deno.json');
}