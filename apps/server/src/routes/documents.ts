import { Hono } from "hono";
import * as documentService from "../services/document.service";
import * as fs from "fs";
import * as path from "path";
import { decryptBuffer, getFileEncryptionKey } from "../utils/crypto";

export const documentsRouter = new Hono();

function handleError(c: any, err: unknown) {
  const e = err as { status?: number; message?: string };
  if (e.status === 404) return c.json({ error: e.message ?? "Not found" }, 404);
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
}

documentsRouter.get("/", async (c) => {
  const investmentId = c.req.query("investment_id") || null;
  const accountId = c.req.query("account_id") || null;
  try {
    const docs = await documentService.listAllDocuments({
      investmentId,
      accountId,
    });
    return c.json({ documents: docs });
  } catch (err) {
    return handleError(c, err);
  }
});

documentsRouter.post("/", async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body.file;
    const name = body.name as string;
    const notes = body.notes as string;
    const investmentId = (body.investment_id as string) || null;
    const accountId = (body.account_id as string) || null;

    if (!file || !(file instanceof File)) {
      return c.json({ error: "File upload is required" }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const doc = await documentService.createDocument(
      { investmentId, accountId },
      name || file.name,
      buffer,
      file.name,
      file.type,
      file.size,
      notes
    );

    return c.json(doc, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

documentsRouter.get("/:docId", async (c) => {
  const docId = c.req.param("docId");
  try {
    const doc = await documentService.getDocumentById(docId);
    if (!doc) {
      return c.json({ error: "Document not found" }, 404);
    }

    const filePath = path.join(documentService.UPLOADS_DIR, doc.file_name);
    if (!fs.existsSync(filePath)) {
      return c.json({ error: "Physical file not found" }, 404);
    }

    let fileBuffer: any = fs.readFileSync(filePath);
    const key = getFileEncryptionKey();
    fileBuffer = decryptBuffer(fileBuffer, key);
    return c.body(new Uint8Array(fileBuffer), 200, {
      "Content-Type": doc.mime_type,
      "Content-Disposition": `inline; filename="${encodeURIComponent(doc.name)}"`,
    });
  } catch (err) {
    return handleError(c, err);
  }
});

documentsRouter.delete("/:docId", async (c) => {
  const docId = c.req.param("docId");
  try {
    await documentService.deleteDocument(docId);
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});
