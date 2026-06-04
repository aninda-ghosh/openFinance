import * as fs from "fs";
import * as path from "path";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { accounts, investment_documents, investments } from "../db/schema";
import { nanoid } from "nanoid";
import { encryptBuffer } from "../utils/crypto";

export const UPLOADS_DIR = process.env.DB_PATH
  ? path.join(path.dirname(process.env.DB_PATH), "uploads", "documents")
  : path.join(process.cwd(), "uploads", "documents");

function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

export async function createDocument(
  parentId: { investmentId?: string | null; accountId?: string | null },
  name: string,
  fileBuffer: Buffer,
  originalName: string,
  mimeType: string,
  size: number,
  notes?: string
) {
  const db = getDb();
  ensureUploadsDir();

  const extension = path.extname(originalName) || ".dat";
  const uniqueId = nanoid(12);
  const diskFileName = `doc_${uniqueId}${extension}`;
  const filePath = path.join(UPLOADS_DIR, diskFileName);

  const key = process.env.FINWISE_DB_KEY;
  const bufferToWrite = encryptBuffer(fileBuffer, key);
  fs.writeFileSync(filePath, bufferToWrite);

  const [row] = await db
    .insert(investment_documents)
    .values({
      investment_id: parentId.investmentId || null,
      account_id: parentId.accountId || null,
      name: name || originalName,
      file_name: diskFileName,
      file_size: size,
      mime_type: mimeType,
      notes: notes || null,
    })
    .returning();

  return row;
}

export async function listAllDocuments(filters?: {
  investmentId?: string | null;
  accountId?: string | null;
}) {
  const db = getDb();
  let query = db
    .select({
      id: investment_documents.id,
      investment_id: investment_documents.investment_id,
      account_id: investment_documents.account_id,
      name: investment_documents.name,
      file_name: investment_documents.file_name,
      file_size: investment_documents.file_size,
      mime_type: investment_documents.mime_type,
      notes: investment_documents.notes,
      created_at: investment_documents.created_at,
      updated_at: investment_documents.updated_at,
      // Joined investment metadata
      investment_name: investments.name,
      investment_asset_type: investments.asset_type,
      investment_currency: investments.currency,
      investment_purchase_value: investments.purchase_value,
      investment_units: investments.units,
      investment_current_value: investments.current_value,
      investment_purchase_date: investments.purchase_date,
      // Joined account metadata
      account_name: accounts.name,
      account_type: accounts.type,
      account_currency: accounts.currency,
      account_balance: accounts.balance,
      account_institution: accounts.institution,
    })
    .from(investment_documents)
    .leftJoin(investments, eq(investment_documents.investment_id, investments.id))
    .leftJoin(accounts, eq(investment_documents.account_id, accounts.id));

  const conditions = [];
  if (filters?.investmentId) {
    conditions.push(eq(investment_documents.investment_id, filters.investmentId));
  }
  if (filters?.accountId) {
    conditions.push(eq(investment_documents.account_id, filters.accountId));
  }

  if (conditions.length > 0) {
    // @ts-ignore
    query = query.where(and(...conditions));
  }

  return await query;
}

export async function listDocuments(investmentId: string) {
  return listAllDocuments({ investmentId });
}

export async function getDocumentById(docId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(investment_documents)
    .where(eq(investment_documents.id, docId))
    .limit(1);
  return row;
}

export async function deleteDocument(docId: string) {
  const db = getDb();
  const doc = await getDocumentById(docId);
  if (!doc) {
    throw Object.assign(new Error("Document not found"), { status: 404 });
  }

  const filePath = path.join(UPLOADS_DIR, doc.file_name);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  await db.delete(investment_documents).where(eq(investment_documents.id, docId));
}
