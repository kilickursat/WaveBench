import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { aliases } from "../../aliases";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

/** Packages bundled into the page; their licences travel with it (MIT requires the notice in every copy). */
const BUNDLED = ["react", "react-dom", "scheduler", "uplot"];

function thirdPartyNotice(): string {
  const parts = BUNDLED.map((name) => {
    const dir = new URL(`../../node_modules/${name}/`, import.meta.url);
    const { version } = JSON.parse(readFileSync(new URL("package.json", dir), "utf8")) as { version: string };
    const text = readFileSync(new URL("LICENSE", dir), "utf8").trim();
    return `${name} ${version}\n\n${text}`;
  });
  const body = parts.join("\n\n----------------------------------------------------------------\n\n").replace(/--/g, "- -");
  return `\n<!--\nWaveBench ${pkg.version}, Apache License 2.0 (https://github.com/kilickursat/WaveBench).\n` +
    `Third-party software included in this file:\n\n${body}\n-->\n`;
}

/**
 * Inline the entry script and stylesheet into index.html, so that the deployed page and the downloadable offline
 * file (wavebench-offline.html, opened from disk) are the same single document. The engine worker is inlined by
 * Vite as a classic script (?worker&inline), which also starts from file:// pages.
 */
function singleFile(): Plugin {
  return {
    name: "wavebench-single-file",
    enforce: "post",
    generateBundle(_options, bundle) {
      const page = bundle["index.html"];
      if (!page || page.type !== "asset") return;
      let html = String(page.source);
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === "chunk" && file.isEntry) {
          const code = file.code.replace(/<\/script/gi, "<\\/script");
          html = html.replace(new RegExp(`<script[^>]*src="[^"]*${escape(name)}"[^>]*></script>`), () => `<script type="module">${code}</script>`);
          delete bundle[name];
        } else if (file.type === "asset" && name.endsWith(".css")) {
          const css = String(file.source).replace(/<\/style/gi, "<\\/style");
          html = html.replace(new RegExp(`<link[^>]*href="[^"]*${escape(name)}"[^>]*>`), () => `<style>${css}</style>`);
          delete bundle[name];
        }
      }
      html = html.replace(/<\/html>\s*$/, `</html>${thirdPartyNotice()}`);
      page.source = html;
      this.emitFile({ type: "asset", fileName: "wavebench-offline.html", source: html });
    },
  };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  base: "./",
  plugins: [react(), singleFile()],
  resolve: { alias: aliases },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  worker: { format: "iife" },
  // The bundled example lives in the repository's examples/ folder, outside the app root.
  server: { fs: { allow: [new URL("../..", import.meta.url).pathname] } },
  build: {
    outDir: new URL("../../dist", import.meta.url).pathname,
    emptyOutDir: true,
    target: "es2022",
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4000,
  },
});
