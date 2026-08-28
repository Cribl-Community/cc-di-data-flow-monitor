// Real build-time constants injected by `vite.config.ts`'s own `define` — distinct from
// `lib/cribl-globals.d.ts`'s `window.*` platform globals (those are injected by the Cribl Apps
// runtime at install time; this one is baked in at build time from this project's own
// `package.json`, the same value on every install of a given release).
declare const __APP_VERSION__: string;
