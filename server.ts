import express from "express";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { unzipSync, strFromU8 } from "fflate";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;
const app = express();
app.use(express.json({ limit: "10mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});
const R2_BUCKET = process.env.R2_BUCKET_NAME || "sitesnap-files";

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    ".html": "text/html", ".htm": "text/html", ".css": "text/css",
    ".js": "application/javascript", ".mjs": "application/javascript",
    ".json": "application/json", ".xml": "application/xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
    ".ttf": "font/ttf", ".otf": "font/otf", ".txt": "text/plain",
    ".webmanifest": "application/manifest+json",
    ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".pdf": "application/pdf",
  };
  return types[ext.toLowerCase()] || "application/octet-stream";
}

function sanitize(str: string): string {
  return String(str).trim().slice(0, 500).replace(/[<>]/g, "");
}

function rewriteHtml(html: string, base: string, localUrl?: string): string {
  const rw = (u: string): string => {
    if (!u || u.length > 500) return u;
    if (u.startsWith("data:") || u.startsWith("mailto:") || u.startsWith("#") || u.startsWith("javascript:")) return u;
    // Replace placeholder URL
    if (u.includes("sitesnap.replace.me")) {
      const path = u.replace(/https?:\/\/sitesnap\.replace\.me\//, "").replace(/https?:\/\/sitesnap\.replace\.me/, "");
      return base + path;
    }
    // Replace localhost URLs
    if (u.includes("localhost") || u.includes("127.0.0.1")) {
      try {
        const parsed = new URL(u);
        const path = parsed.pathname.replace(/^\//, "");
        return base + path + (parsed.search || "");
      } catch { return u; }
    }
    if (u.startsWith("//") || u.startsWith("http://") || u.startsWith("https://")) return u;
    if (u.startsWith("/")) return base + u.slice(1);
    return u;
  };
  // Only rewrite HTML tag attributes — not inside script content
  // Split by <script> blocks to avoid rewriting JS code
  const parts = html.split(/(<script[\s\S]*?<\/script>)/gi);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].toLowerCase().startsWith("<script")) continue; // skip script blocks
    parts[i] = parts[i]
      .replace(/(<img[^>]*?\s)src=["']([^"']+)["']/gi, (_, pre, u) => `${pre}src="${rw(u)}"`)
      .replace(/(<source[^>]*?\s)src=["']([^"']+)["']/gi, (_, pre, u) => `${pre}src="${rw(u)}"`)
      .replace(/(<link[^>]*?\s)href=["']([^"']+)["']/gi, (_, pre, u) => `${pre}href="${rw(u)}"`)
      .replace(/(<script[^>]*?\s)src=["']([^"']+)["']/gi, (_, pre, u) => `${pre}src="${rw(u)}"`)
      .replace(/(<a[^>]*?\s)href=["']([^"'#][^"']*)["']/gi, (_, pre, u) => `${pre}href="${rw(u)}"`)
      .replace(/(<form[^>]*?\s)action=["']([^"']+)["']/gi, (_, pre, u) => `${pre}action="${rw(u)}"`)
      .replace(/(<img[^>]*?\s)srcset=["']([^"']+)["']/gi, (_, pre, srcset) => {
        const rewritten = srcset.replace(/(^|,\s*)(\S+)/g, (m: string, sep: string, url: string) => {
          const pts = url.split(/\s+/); pts[0] = rw(pts[0]); return sep + pts.join(" ");
        });
        return `${pre}srcset="${rewritten}"`;
      });
  }
  html = parts.join("");
  // Rewrite url() in style tags only
  html = html.replace(/(<style[\s\S]*?<\/style>)/gi, (styleBlock) => {
    return styleBlock.replace(/url\(["']?([^"')\s]+)["']?\)/gi, (_, u) => `url('${rw(u)}')`);
  });
  // Rewrite inline style attributes
  html = html.replace(/(style=["'][^"']*url\()["']?(\/[^"')\s]+)["']?/gi, (_, pre, u) => `${pre}'${rw(u)}'`);
  // Remove vite HMR
  html = html.replace(/<script[^>]+src=["'][^"']*@vite[^"']*["'][^>]*><\/script>/gi, "");
  return html;
}

function rewriteCss(css: string, base: string): string {
  const rw = (u: string): string => {
    if (!u) return u;
    if (u.startsWith("data:")) return u;
    if (u.includes("localhost") || u.includes("127.0.0.1")) {
      try { const parsed = new URL(u); return base + parsed.pathname.replace(/^\//, ""); } catch { return u; }
    }
    if (u.startsWith("//") || u.startsWith("http://") || u.startsWith("https://")) return u;
    if (u.startsWith("/")) return base + u.slice(1);
    return u;
  };
  return css.replace(/url\(["']?([^"')]+)["']?\)/gi, (_, u) => `url('${rw(u)}')`);
}

async function getFromR2(key: string): Promise<Buffer | null> {
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    if (!res.Body) return null;
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as any) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch { return null; }
}

async function deleteFromR2(prefix: string) {
  try {
    const list = await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix }));
    if (!list.Contents?.length) return;
    for (const obj of list.Contents) {
      if (obj.Key) await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: obj.Key }));
    }
  } catch (e) { console.error("R2 delete error:", e); }
}

// ── The actual processing function ───────────────────────────────────────────
async function processZip(r2Key: string, fileName: string, userId: string, siteId: string) {
  try {
    console.log(`[${siteId}] Downloading ZIP from R2: ${r2Key}`);
    const zipBuffer = await getFromR2(r2Key);
    if (!zipBuffer) { console.error(`[${siteId}] ZIP not found in R2`); return; }

    console.log(`[${siteId}] ZIP size: ${(zipBuffer.length / 1024 / 1024).toFixed(2)}MB`);

    const zipData = new Uint8Array(zipBuffer);
    // (buffer freed after conversion to Uint8Array)

    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(zipData);
    } catch (e) {
      console.error(`[${siteId}] Could not unzip:`, e);
      await deleteFromR2(r2Key);
      return;
    }
    // (zipData processed, continuing with files)

    const keys = Object.keys(files);
    if (!keys.length) { console.error(`[${siteId}] ZIP is empty`); return; }

    const indexKey = keys.find(k => {
      const n = k.toLowerCase();
      return !n.includes("__macosx") && (n === "index.html" || n.endsWith("/index.html"));
    });
    if (!indexKey) { console.error(`[${siteId}] No index.html found`); await deleteFromR2(r2Key); return; }

    const siteName = sanitize(fileName.replace(/\.zip$/i, "") || "Untitled Site");
    const workerUrl = (process.env.WORKER_URL || "").trim().replace(/\/$/, "");
    const siteUrl = `${workerUrl}/sites/${siteId}/`;
    const base = siteUrl;

    // Detect source URL — placeholder or localhost
    let localUrl = "";
    let usePlaceholder = false;
    try {
      const indexData = files[indexKey];
      const indexHtml = strFromU8(indexData);

      if (indexHtml.includes("sitesnap.replace.me")) {
        localUrl = "https://sitesnap.replace.me";
        usePlaceholder = true;
        console.log(`[${siteId}] Detected placeholder in index.html`);
      } else {
        // Check a few CSS/JS files too in case index.html doesn't have it
        const sampleKeys = keys.filter(k => k.endsWith(".css") || k.endsWith(".js")).slice(0, 5);
        for (const sk of sampleKeys) {
          try {
            const sample = strFromU8(files[sk]).substring(0, 500);
            if (sample.includes("sitesnap.replace.me")) {
              usePlaceholder = true;
              localUrl = "https://sitesnap.replace.me";
              console.log(`[${siteId}] Detected placeholder in ${sk}`);
              break;
            }
          } catch {}
        }
        if (!usePlaceholder) {
          const match = indexHtml.match(/https?:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?(\/[^"'\s<]*)?/i);
          if (match) {
            const u = new URL(match[0]);
            const pathParts = u.pathname.split("/").filter(Boolean);
            localUrl = u.origin + (pathParts.length > 1 ? "/" + pathParts.slice(0, -1).join("/") : "");
            if (!localUrl.endsWith("/")) localUrl += "/";
            console.log(`[${siteId}] Detected local URL: ${localUrl}`);
          }
        }
      }
    } catch {}

    let rootPrefix = "";
    const parts = indexKey.split("/");
    if (parts.length > 1) rootPrefix = parts.slice(0, -1).join("/") + "/";

    const filesToUpload = keys.filter(k => {
      const n = k.toLowerCase();
      return !n.includes("__macosx") && !k.endsWith("/") && files[k].length > 0;
    });

    console.log(`[${siteId}] Uploading ${filesToUpload.length} files to R2...`);

    for (let i = 0; i < filesToUpload.length; i += 5) {
      const batch = filesToUpload.slice(i, i + 5);
      await Promise.all(batch.map(async (key) => {
        let relKey = key;
        if (rootPrefix && relKey.startsWith(rootPrefix)) relKey = relKey.slice(rootPrefix.length);
        if (!relKey) return;

        const r2FileKey = `sites/${siteId}/${relKey}`;
        const ext = relKey.includes(".") ? relKey.substring(relKey.lastIndexOf(".")) : "";
        let fileData: Uint8Array = files[key];

        if (ext === ".html" || ext === ".htm") {
          try {
            let html = strFromU8(fileData);
            // Direct string replacement of placeholder — catches ALL occurrences including query strings
            if (usePlaceholder) {
              html = html.split("https://sitesnap.replace.me/").join(base);
              html = html.split("https://sitesnap.replace.me").join(base.replace(/\/$/, ""));
            }
            fileData = new TextEncoder().encode(rewriteHtml(html, base, localUrl));
          } catch {}
        } else if (ext === ".css") {
          try {
            let css = strFromU8(fileData);
            if (usePlaceholder) {
              css = css.split("https://sitesnap.replace.me/").join(base);
              css = css.split("https://sitesnap.replace.me").join(base.replace(/\/$/, ""));
            }
            fileData = new TextEncoder().encode(rewriteCss(css, base));
          } catch {}
        } else if (ext === ".js" || ext === ".mjs") {
          try {
            let js = strFromU8(fileData);
            if (usePlaceholder && js.includes("sitesnap.replace.me")) {
              js = js.split("https://sitesnap.replace.me/").join(base);
              js = js.split("https://sitesnap.replace.me").join(base.replace(/\/$/, ""));
              fileData = new TextEncoder().encode(js);
            }
          } catch {}
        }

        await r2.send(new PutObjectCommand({
          Bucket: R2_BUCKET, Key: r2FileKey, Body: fileData,
          ContentType: getContentType(ext),
        }));
        // uploaded
      }));

      if ((i + 5) % 100 === 0 || i + 5 >= filesToUpload.length) {
        console.log(`[${siteId}] Uploaded ${Math.min(i + 5, filesToUpload.length)}/${filesToUpload.length}`);
      }
    }

    await deleteFromR2(r2Key);

    await pool.query(
      "INSERT INTO sites (id, user_id, name, url) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET url = $4",
      [siteId, userId, siteName, siteUrl]
    );

    console.log(`[${siteId}] Done! Deployed at ${siteUrl}`);
  } catch (e: any) {
    console.error(`[${siteId}] Processing error:`, e.message);
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.json({ status: "ok", service: "SiteSnap Processor" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Process ZIP ── RESPONDS IMMEDIATELY then processes in background ───────────
app.post("/process", (req, res) => {
  const secret = req.headers["x-worker-secret"];
  if (secret !== process.env.WORKER_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { r2Key, fileName, userId, siteId: providedSiteId } = req.body;
  if (!r2Key || !fileName || !userId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const siteId = providedSiteId || uuidv4();

  console.log(`[${siteId}] Received request, starting background processing...`);

  // ✅ RESPOND IMMEDIATELY — Vercel gets 200 right away
  res.json({ status: "processing", siteId });

  // ✅ PROCESS IN BACKGROUND — after response is sent
  processZip(r2Key, fileName, userId, siteId);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`SiteSnap Processor running on port ${PORT}`));

export default app;
