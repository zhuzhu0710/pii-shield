/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { BRAND_NAME, BRAND_TAGLINE } from './src/brand';

/** Fills the `__BRAND_NAME__` and `__BRAND_TAGLINE__` placeholders in index.html from src/brand.ts. */
function brandPlaceholders(): Plugin {
  return {
    name: 'brand-placeholders',
    transformIndexHtml: (html) => html.replaceAll('__BRAND_NAME__', BRAND_NAME).replaceAll('__BRAND_TAGLINE__', BRAND_TAGLINE),
  };
}

/**
 * The OCR worker, engine and language models, served from this site under fixed names (tesseract.js
 * picks the core variant by file name and otherwise downloads everything from a CDN).
 * See specs/004-scanned-pdf-ocr/contracts/ocr-assets.md.
 */
const OCR_ASSETS: Record<string, string> = {
  'ocr/worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
  ...Object.fromEntries(
    ['lstm', 'simd-lstm', 'relaxedsimd-lstm'].map((v) => [`ocr/core/tesseract-core-${v}.wasm.js`, `node_modules/tesseract.js-core/tesseract-core-${v}.wasm.js`]),
  ),
  ...Object.fromEntries(
    ['chi_tra', 'eng'].map((l) => [`ocr/lang/${l}.traineddata.gz`, `node_modules/@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`]),
  ),
};

function ocrAssets(): Plugin {
  let root = '.';
  return {
    name: 'ocr-assets',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const src = OCR_ASSETS[(req.url ?? '').split('?')[0].replace(/^\//, '')];
        if (!src) return next();
        res.setHeader('Content-Type', src.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        res.end(readFileSync(resolve(root, src)));
      });
    },
    generateBundle() {
      for (const [fileName, src] of Object.entries(OCR_ASSETS)) this.emitFile({ type: 'asset', fileName, source: readFileSync(resolve(root, src)) });
    },
  };
}

/** The license text ships with the site: LICENSE at the repo root is the single source, copied to LICENSE.txt. */
const LICENSE_SOURCE = 'LICENSE';
const LICENSE_NAME = 'LICENSE.txt';
/** Kept at the top of every built JS chunk so the notice survives copying the bundle alone. */
const LICENSE_BANNER = '/*! 個資隱身術 — MIT License. Portions © 2026 Dean Lin (data-deidentification). See LICENSE.txt */';

function licenseFile(): Plugin {
  let root = '.';
  return {
    name: 'license-file',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== `/${LICENSE_NAME}`) return next();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(readFileSync(resolve(root, LICENSE_SOURCE)));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: LICENSE_NAME, source: readFileSync(resolve(root, LICENSE_SOURCE)) });
    },
  };
}

/** Added after minification, which would otherwise drop the /*! notice. */
function licenseBanner(): Plugin {
  return {
    name: 'license-banner',
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') item.code = `${LICENSE_BANNER}\n${item.code}`;
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [brandPlaceholders(), ocrAssets(), licenseFile(), licenseBanner()],
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    // PDF/docx round-trips embed fonts and zip files; give them headroom on slow CI runners.
    testTimeout: 30000,
  },
});
