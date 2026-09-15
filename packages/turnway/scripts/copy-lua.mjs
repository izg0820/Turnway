// Ship the Lua scripts with the build output (dist)
import { cp, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'lua');
const to = join(root, 'dist', 'lua');

await cp(from, to, { recursive: true });
const copied = await readdir(to);
console.log(`[turnway] lua scripts copied: ${copied.join(', ')}`);
