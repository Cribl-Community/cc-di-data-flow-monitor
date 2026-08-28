import { defineConfig, type IndexHtmlTransformContext, type IndexHtmlTransformResult, type ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'path'
import react from '@vitejs/plugin-react'
// @ts-ignore
import { servePackageTgz } from './scripts/pkgutil.mjs'

const packageEndpointPlugin = () => ({
  name: 'vite-plugin-package-endpoint',
  configureServer(server: ViteDevServer) {
    server.middlewares.use('/package.tgz', (req: IncomingMessage, res: ServerResponse) => {
      void servePackageTgz(req, res, server.config.root)
    })
  },
})

// Real build-time constant, not a platform-injected global (see `src/vite-env.d.ts`'s own doc
// comment for that distinction) — read once here, the same `readFileSync` pattern
// `injectScriptFromQueryPlugin` below already uses for the app's own `name`, so the Help panel's
// About tab can show the real shipped version without embedding any environment-specific value.
const pkgVersion = (() => {
  try {
    return (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const WATCHED_CONFIG_FILES = ['package.json', 'config/proxies.yml', 'config/policies.yml'];
const CONFIG_CHANGED_HMR_EVENT = 'cribl:config-changed';

const CONFIG_CHANGED_BRIDGE = `
import { createHotContext } from '/@vite/client';
const hot = createHotContext('cribl:config-watcher');
hot.on('${CONFIG_CHANGED_HMR_EVENT}', (data) => {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'CRIBL_APP_CONFIG_CHANGED', file: data && data.file }, '*');
  }
  window.location.reload();
});
`;

const injectScriptFromQueryPlugin = () => {
  let initScriptUrl: string | null = null;
  return {
    name: 'inject-script-from-query',
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      const watched = WATCHED_CONFIG_FILES.map((rel) => join(root, rel));
      server.watcher.add(watched);
      server.watcher.on('change', (file) => {
        const idx = watched.indexOf(file);
        if (idx === -1) return;
        server.ws.send(CONFIG_CHANGED_HMR_EVENT, { file: WATCHED_CONFIG_FILES[idx] });
      });
    },
    transformIndexHtml(html: string, ctx: IndexHtmlTransformContext): IndexHtmlTransformResult{
      const url = new URL(ctx.originalUrl ?? '/', 'https://localhost');
      // Prefer *this* request's own `?init=`, falling back to whatever was last remembered only
      // when this particular request doesn't specify one (a plain reload of a URL that already
      // dropped the query string) — found live while testing multiple simulated users against one
      // long-running dev server: the previous `initScriptUrl || ...` reversed that precedence, so
      // once any request ever set it, every later request was silently stuck replaying that first
      // value forever, no matter what `?init=` it asked for.
      initScriptUrl = url.searchParams.get('init') || initScriptUrl;
      const root = process.cwd();
      let appName;
      try {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { name?: string };
        appName = pkg.name;
      } catch {
        /* ignore missing or invalid package.json */
      }
      appName = appName || 'unknown';
      const tags: Array<{ tag: string; attrs?: Record<string, string>; children?: string; injectTo: 'head-prepend' }> = [];
      if (ctx.server) {
        // Dev-server-only stand-in for what the real Cribl platform injects once this app is
        // actually installed (`window.CRIBL_APP_ID` is declared `readonly ... ?: string` in
        // `lib/cribl-globals.d.ts` precisely because it's the *platform's* job to set it, not this
        // app's own). Previously pushed unconditionally, meaning every real production build
        // (`npm run build`/`npm run package`) baked this literal `__dev__`-prefixed placeholder
        // into `dist/index.html` — shipped to every installing org's real environment, where it
        // could pre-empt or confuse whatever value the platform's own host page tries to set.
        tags.push({
          tag: 'script',
          children: `window.CRIBL_APP_ID = '__dev__${appName}';`,
          injectTo: 'head-prepend' as const,
        });
        tags.push({
          tag: 'script',
          attrs: { type: 'module' },
          children: CONFIG_CHANGED_BRIDGE,
          injectTo: 'head-prepend' as const,
        });
      }
      if (initScriptUrl) {
        tags.push({
          tag: 'script',
          attrs: { src: initScriptUrl, type: 'text/javascript' },
          injectTo: 'head-prepend' as const,
        });
      }
      return { html, tags };
    },
  };
};

export default defineConfig({
  plugins: [react(), packageEndpointPlugin(), injectScriptFromQueryPlugin()],
  base: './',
  server: {
    cors: true,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
})

