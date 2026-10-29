import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/ui', { recursive: true });
cpSync('src/ui', 'dist/ui', { recursive: true });
