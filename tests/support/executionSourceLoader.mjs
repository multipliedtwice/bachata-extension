import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {
      const parent = context.parentURL ?? pathToFileURL(path.join(process.cwd(), '_entry.cjs')).href;
      let candidate = fileURLToPath(new URL(specifier, parent));
      if (candidate.includes('/dist/')) candidate = candidate.replace('/dist/', '/src/').replace(/\.js$/, '.ts');
      if (!path.extname(candidate) && existsSync(candidate + '.ts')) candidate += '.ts';
      if (candidate.endsWith('.ts') && existsSync(candidate)) return { url: pathToFileURL(candidate).href, format: 'module', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true };
    return next(url, context);
  }
});
