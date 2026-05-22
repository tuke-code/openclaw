#!/usr/bin/env tsx
/**
 * Copy export-html templates from src to dist
 */

import fs from "node:fs";
import path from "node:path";
import { ensureDirectory, logVerboseCopy, resolveBuildCopyContext } from "./lib/copy-assets.ts";

const context = resolveBuildCopyContext(import.meta.url);

const sessionTemplateSrcDir = path.join(
  context.projectRoot,
  "src",
  "agents",
  "sessions",
  "export-html",
);
const sessionTemplateDistDir = path.join(
  context.projectRoot,
  "dist",
  "agents",
  "sessions",
  "export-html",
);
const sharedVendorSrcDir = path.join(
  context.projectRoot,
  "src",
  "auto-reply",
  "reply",
  "export-html",
  "vendor",
);
const sharedVendorDistDir = path.join(context.projectRoot, "dist", "export-html", "vendor");

function copyExportHtmlTemplates() {
  if (!fs.existsSync(sessionTemplateSrcDir)) {
    console.warn(`${context.prefix} Source directory not found:`, sessionTemplateSrcDir);
    return;
  }

  ensureDirectory(sessionTemplateDistDir);

  const templateFiles = ["template.html", "template.css", "template.js"];
  let copiedCount = 0;
  for (const file of templateFiles) {
    const srcFile = path.join(sessionTemplateSrcDir, file);
    const distFile = path.join(sessionTemplateDistDir, file);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, distFile);
      copiedCount += 1;
      logVerboseCopy(context, `Copied ${file}`);
    }
  }

  if (fs.existsSync(sharedVendorSrcDir)) {
    ensureDirectory(sharedVendorDistDir);
    const vendorFiles = fs.readdirSync(sharedVendorSrcDir);
    for (const file of vendorFiles) {
      const srcFile = path.join(sharedVendorSrcDir, file);
      const distFile = path.join(sharedVendorDistDir, file);
      if (fs.statSync(srcFile).isFile()) {
        fs.copyFileSync(srcFile, distFile);
        copiedCount += 1;
        logVerboseCopy(context, `Copied vendor/${file}`);
      }
    }
  }

  console.log(`${context.prefix} Copied ${copiedCount} export-html assets.`);
}

copyExportHtmlTemplates();
