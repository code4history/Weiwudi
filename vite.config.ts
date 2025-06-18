import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8'));
const isPackageBuild = process.env.BUILD_MODE === 'package';

// Plugin to remove .ts extensions from imports
const removeTsExtensions = () => {
  return {
    name: 'remove-ts-extensions',
    transform(code, id) {
      if (id.endsWith('.ts') || id.endsWith('.tsx')) {
        // Replace imports with .ts extensions
        return code.replace(
          /from\s+['"](\.\/[^'"]+)\.ts['"]/g,
          'from "$1"'
        );
      }
      return code;
    }
  };
};

export default defineConfig({
  base: './',
  build: isPackageBuild ? {
    lib: {
      entry: {
        'weiwudi': resolve(__dirname, 'src/index.ts'),
        'weiwudi_sw': resolve(__dirname, 'src/weiwudi_sw.ts')
      },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => {
        const ext = format === 'es' ? 'js' : 'cjs';
        return `${entryName}.${ext}`;
      }
    },
    rollupOptions: {
      external: [
        'workbox-core',
        'workbox-routing',
        'workbox-strategies',
        'workbox-expiration',
        'workbox-precaching'
      ]
    }
  } : {
    outDir: 'dist',
    emptyOutDir: true
  },
  plugins: [
    removeTsExtensions(),
    dts({
      outDir: 'dist',
      exclude: ['tests', 'node_modules'],
      rollupTypes: false,
      skipDiagnostics: true,
      tsconfigPath: './tsconfig.json',
      logLevel: 'silent',
      insertTypesEntry: true,
      staticImport: true,
      beforeWriteFile: (filePath, content) => {
        // Remove .ts extensions from imports in .d.ts files
        const fixedContent = content
          .replace(/from ['"](\.[^'"]+)\.ts['"]/g, 'from "$1"')
          .replace(/import\(["'](\.[^'"]+)\.ts["']\)/g, 'import("$1")');
        return {
          filePath,
          content: fixedContent
        };
      }
    })
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts']
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src')
    }
  },
  define: {
    'import.meta.env.APP_VERSION': JSON.stringify(packageJson.version)
  }
});