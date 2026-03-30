import express from "express";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { unzipSync, strFromU8 } from "fflate";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;
const app = express();
app.use(express.json({ limit: "10mb" }));

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

// ── R2 ────────────────────────────────────────────────────────────────────────
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});
const R2_BUCKET = process.env.R2_BUCKET_NAME || "sitesnap-files";

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function rewriteHtml(html: string, base: string): string {
  html = html.replace(/(<(?:a|link|script|img|form|iframe|source)\s[^>]*(?:href|src|action)=["'])\/(?!\/)([^"']*)(["'])/gi, (_,b,u,a) => `${b}${base}${u}${a}`);
  html = html.replace(/url\(['"]?\/(?!\/)([^'")]+)['"]?\)/gi, (_,u) => `url('${base}${u}')`);
  html = html.replace(/<script[^>]+src=["'][^"']*@vite[^"']*["'][^>]*><\/script>/gi, "");
  return html;
}

function rewriteCss(css: string, base: string): string {
  return css.replace(/url\(['"]?\/(?!\/)([^'")]+)['"]?\)/gi, (_,u) => `url('${base}${u}')`);
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

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.json({ status: "ok", service: "SiteSnap Processor" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Process ZIP ───────────────────────────────────────────────────────────────
app.post("/process", async (req, res) => {
  // Verify secret
  const secret = req.headers["x-worker-secret"];
  if (secret !== process.env.WORKER_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { r2Key, fileName, userId, siteId: providedSiteId } = req.body;

  if (!r2Key || !fileName || !userId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  console.log(`Processing: ${fileName} for user ${userId}`);

  try {
    // Download ZIP from R2
    console.log(`Downloading from R2: ${r2Key}`);
    const zipBuffer = await getFromR2(r2Key);
    if (!zipBuffer) {
      return res.status(400).json({ error: "Upload not found. Please try again." });
    }

    console.log(`ZIP size: ${(zipBuffer.length / 1024 / 1024).toFixed(2)}MB`);

    // Unzip
    const zipData = new Uint8Array(zipBuffer);
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(zipData);
    } catch (e) {
      await deleteFromR2(r2Key);
      return res.status(422).json({ error: "invalid_zip", message: "Could not read ZIP file." });
    }

    const keys = Object.keys(files);
    if (!keys.length) {
      await deleteFromR2(r2Key);
      return res.status(422).json({ error: "invalid_zip", message: "ZIP is empty." });
    }

    // Validate — find index.html
    const indexKey = keys.find(k => {
      const n = k.toLowerCase();
      return !n.includes("__macosx") && (n === "index.html" || n.endsWith("/index.html"));
    });

    if (!indexKey) {
      await deleteFromR2(r2Key);
      return res.status(422).json({ error: "invalid_zip", message: "No index.html found. Export using Simply Static plugin." });
    }

    // Security check - no path traversal
    for (const key of keys) {
      if (key.includes("../") || key.includes("..\\")) {
        await deleteFromR2(r2Key);
        return res.status(422).json({ error: "invalid_zip", message: "Invalid ZIP: unsafe paths." });
      }
    }

    const siteId = providedSiteId || uuidv4();
    const siteName = sanitize(fileName.replace(/\.zip$/i, "") || "Untitled Site");

    // Determine root prefix (some ZIPs have a top-level folder)
    let rootPrefix = "";
    const parts = indexKey.split("/");
    if (parts.length > 1) rootPrefix = parts.slice(0, -1).join("/") + "/";

    // The Worker URL is still used to SERVE the files
    const workerUrl = (process.env.WORKER_URL || "").trim().replace(/\/$/, "");
    const siteUrl = `${workerUrl}/sites/${siteId}/`;
    const base = siteUrl;

    console.log(`Uploading ${keys.length} files to R2 for site ${siteId}...`);

    // Upload files to R2 in batches of 20
    const filesToUpload = keys.filter(k => {
      const n = k.toLowerCase();
      return !n.includes("__macosx") && !k.endsWith("/") && files[k].length > 0;
    });

    for (let i = 0; i < filesToUpload.length; i += 20) {
      const batch = filesToUpload.slice(i, i + 20);
      await Promise.all(batch.map(async (key) => {
        let relKey = key;
        if (rootPrefix && relKey.startsWith(rootPrefix)) relKey = relKey.slice(rootPrefix.length);
        if (!relKey) return;

        const r2FileKey = `sites/${siteId}/${relKey}`;
        const ext = relKey.includes(".") ? relKey.substring(relKey.lastIndexOf(".")) : "";
        let fileData: Uint8Array = files[key];

        // Rewrite absolute paths in HTML and CSS
        if (ext === ".html" || ext === ".htm") {
          try {
            const rewritten = rewriteHtml(strFromU8(fileData), base);
            fileData = new TextEncoder().encode(rewritten);
          } catch {}
        } else if (ext === ".css") {
          try {
            const rewritten = rewriteCss(strFromU8(fileData), base);
            fileData = new TextEncoder().encode(rewritten);
          } catch {}
        }

        await r2.send(new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: r2FileKey,
          Body: fileData,
          ContentType: getContentType(ext),
        }));
      }));

      if (i % 100 === 0) console.log(`Uploaded ${Math.min(i + 20, filesToUpload.length)}/${filesToUpload.length} files`);
    }

    // Delete the temp ZIP from R2
    await deleteFromR2(r2Key);

    // Save to database
    await pool.query(
      "INSERT INTO sites (id, user_id, name, url) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET url = $4",
      [siteId, userId, siteName, siteUrl]
    );

    console.log(`Done! Site ${siteId} deployed at ${siteUrl}`);

    return res.json({
      id: siteId,
      name: siteName,
      url: siteUrl,
      completed: true,
      filesUploaded: filesToUpload.length,
    });

  } catch (e: any) {
    console.error("Processing error:", e);
    return res.status(500).json({ error: "Processing failed: " + e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`SiteSnap Processor running on port ${PORT}`);
});

export default app;
