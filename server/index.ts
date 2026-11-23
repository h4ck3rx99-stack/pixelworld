import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';

const env = (k: string, d: number) => Number(process.env[k]) || d;

const { app } = createApp({
  dataDir: process.env.DATA_DIR || './data',
  adminSecret: process.env.ADMIN_SECRET || undefined,
  limits: {
    cooldownMs: env('COOLDOWN_MS', 4000),
    ipPerMin: env('IP_PER_MIN', 90),
    deviceDaily: env('DEVICE_DAILY', 600),
    ipDaily: env('IP_DAILY', 5000),
  },
});

// Built front-end: hashed assets cache forever, everything else revalidates.
app.use('/assets/*', async (c, next) => {
  await next();
  c.header('cache-control', 'public, max-age=31536000, immutable');
});
app.use('*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

const port = env('PORT', 8787);
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => console.log(`RangoliLive on http://localhost:${port}`));
