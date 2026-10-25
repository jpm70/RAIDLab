import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Solo la web publicada lleva CSP: el servidor de desarrollo inyecta scripts
// en línea y la versión offline lo mete todo en un único HTML.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspEnBuild() {
  return {
    name: 'raidlab-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      ),
  };
}

// En la versión offline el logo de la cabecera, el pie y el favicon van incrustados.
function logoIncrustado() {
  const dataUri = `data:image/png;base64,${readFileSync('src/assets/icono.png').toString('base64')}`;
  return {
    name: 'raidlab-logo-incrustado',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replaceAll('/src/assets/icono.png', dataUri) },
  };
}

// `vite build` genera la web para GitHub Pages en dist/.
// `vite build --mode offline` genera dist-offline/index.html con todo incrustado;
// scripts/copiar-offline.mjs lo copia a dist/raidlab.html.
export default defineConfig(({ mode }) => {
  const offline = mode === 'offline';
  return {
    // Rutas relativas: funciona en https://<org>.github.io/RAIDLab/ y con file://
    base: './',
    plugins: [tailwindcss(), ...(offline ? [logoIncrustado(), viteSingleFile()] : [cspEnBuild()])],
    build: offline
      ? { outDir: 'dist-offline', emptyOutDir: true, assetsInlineLimit: () => true, chunkSizeWarningLimit: 4000 }
      : { outDir: 'dist', chunkSizeWarningLimit: 1500 },
  };
});
