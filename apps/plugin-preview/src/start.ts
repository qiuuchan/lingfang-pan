import { createPreviewOriginServer } from './server';

const port = Number(process.env.PORT || 19007);
const server = createPreviewOriginServer({
  internalOrigin: process.env.COLLAB_API_INTERNAL_ORIGIN || 'http://127.0.0.1:3000',
  serviceKey: process.env.PLUGIN_PREVIEW_SERVICE_KEY || '',
  webAppOrigins: (process.env.PREVIEW_WEB_APP_ORIGINS || 'http://localhost:19006')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  publicOrigin: process.env.PLUGIN_PREVIEW_PUBLIC_ORIGIN,
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`LingFang plugin preview origin listening on :${port}\n`);
});
