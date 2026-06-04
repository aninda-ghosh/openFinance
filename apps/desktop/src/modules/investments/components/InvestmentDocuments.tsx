import { useState, useRef } from "react";
import { toast } from "sonner";
import {
  FileText,
  Image as ImageIcon,
  FileSpreadsheet,
  File as FileIcon,
  UploadCloud,
  Trash2,
  Loader2,
  ExternalLink,
} from "lucide-react";
import {
  useDocumentsList,
  useUploadDocumentMutation,
  useDeleteDocumentMutation,
} from "@/modules/documents/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { BASE_URL, getToken } from "@/lib/api";
import { formatCurrency } from "@finwise/shared/utils";
import { isTauri } from "@/lib/utils";

interface InvestmentDocumentsProps {
  investmentId: string;
  investment: any;
  isAccount?: boolean;
}

export function InvestmentDocuments({
  investmentId,
  investment,
  isAccount = false,
}: InvestmentDocumentsProps) {
  const filters = isAccount ? { accountId: investmentId } : { investmentId };
  const { data = { documents: [] }, isLoading } = useDocumentsList(filters);
  const { mutate: uploadDoc, isPending: uploading } = useUploadDocumentMutation();
  const { mutate: deleteDoc, isPending: deleting } = useDeleteDocumentMutation();

  const handleOpenFile = async (docId: string) => {
    const url = `${BASE_URL}/api/documents/${docId}?token=${encodeURIComponent(getToken() || "")}`;
    if (isTauri()) {
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
      } catch (err) {
        console.error("Failed to open file via Tauri opener:", err);
        toast.error("Failed to open file. Make sure your system has a default app for this file type.");
      }
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const [docName, setDocName] = useState("");
  const [docNotes, setDocNotes] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const documents = data.documents || [];

  // Helper to format file sizes
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  // Helper to resolve Lucide icon based on MIME type
  const getFileIcon = (mimeType: string) => {
    if (mimeType.includes("pdf")) {
      return <FileText className="w-8 h-8 text-rose-500" />;
    }
    if (mimeType.includes("image")) {
      return <ImageIcon className="w-8 h-8 text-blue-500" />;
    }
    if (
      mimeType.includes("sheet") ||
      mimeType.includes("excel") ||
      mimeType.includes("csv")
    ) {
      return <FileSpreadsheet className="w-8 h-8 text-emerald-500" />;
    }
    return <FileIcon className="w-8 h-8 text-muted-foreground" />;
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      setSelectedFile(file);
      if (!docName) {
        // Pre-fill display name with file basename (without extension)
        const nameWithoutExt = file.name.substring(0, file.name.lastIndexOf(".")) || file.name;
        setDocName(nameWithoutExt);
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      setSelectedFile(file);
      if (!docName) {
        const nameWithoutExt = file.name.substring(0, file.name.lastIndexOf(".")) || file.name;
        setDocName(nameWithoutExt);
      }
    }
  };

  const handleUploadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      toast.error("Please select or drop a file to upload.");
      return;
    }

    uploadDoc(
      {
        parentId: isAccount ? { accountId: investmentId } : { investmentId },
        name: docName || selectedFile.name,
        file: selectedFile,
        notes: docNotes || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Document uploaded successfully!");
          // Reset form
          setSelectedFile(null);
          setDocName("");
          setDocNotes("");
          if (fileInputRef.current) fileInputRef.current.value = "";
        },
        onError: (err) => {
          toast.error(err.message || "Failed to upload document.");
        },
      }
    );
  };

  const handleDelete = (docId: string, name: string) => {
    if (window.confirm(`Are you sure you want to permanently delete "${name}"?`)) {
      deleteDoc(
        { docId },
        {
          onSuccess: () => {
            toast.success("Document deleted successfully!");
          },
          onError: (err) => {
            toast.error(err.message || "Failed to delete document.");
          },
        }
      );
    }
  };

  return (
    <div className="space-y-6">
      {/* ─── Upload Form ─── */}
      <form onSubmit={handleUploadSubmit} className="space-y-4 rounded-xl border border-border p-4 bg-card">
        <h3 className="text-sm font-semibold tracking-tight uppercase text-muted-foreground">
          Upload New Document
        </h3>
        
        {/* Dropzone */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`flex flex-col items-center justify-center border border-dashed rounded-lg p-6 cursor-pointer transition-colors ${
            isDragOver
              ? "border-primary bg-primary/5"
              : selectedFile
              ? "border-muted-foreground/30 bg-muted/20"
              : "border-muted-foreground/20 hover:border-primary/50 hover:bg-muted/10"
          }`}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden"
            accept=".pdf,.png,.jpg,.jpeg,.gif,.csv,.xls,.xlsx"
          />
          <UploadCloud className={`w-8 h-8 mb-2 ${selectedFile ? "text-primary" : "text-muted-foreground/70"}`} />
          {selectedFile ? (
            <div className="text-center">
              <p className="text-sm font-medium text-foreground max-w-[300px] truncate">
                {selectedFile.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(selectedFile.size)}
              </p>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">
                Drag & drop your statement here, or click to browse
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Supports PDF, Images, Spreadsheet sheets (max 10MB)
              </p>
            </div>
          )}
        </div>

        {/* Inputs */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="doc-display-name">Document Display Name</Label>
            <Input
              id="doc-display-name"
              placeholder="e.g. Q1 Brokerage Statement"
              value={docName}
              onChange={(e) => setDocName(e.target.value)}
              maxLength={100}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="doc-notes">Optional Notes</Label>
            <Input
              id="doc-notes"
              placeholder="e.g. Generated by HDFC Life"
              value={docNotes}
              onChange={(e) => setDocNotes(e.target.value)}
              maxLength={200}
            />
          </div>
        </div>

        <Button
          type="submit"
          className="w-full h-10 font-medium"
          disabled={uploading || !selectedFile}
        >
          {uploading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Uploading to secure filesystem...
            </>
          ) : (
            "Save Document"
          )}
        </Button>
      </form>

      {/* ─── Documents Grid/List ─── */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold tracking-tight uppercase text-muted-foreground">
          Uploaded Documents
        </h3>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        ) : documents.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border p-8 bg-muted/10 text-center">
            <FileIcon className="w-10 h-10 text-muted-foreground/50 mb-2" />
            <p className="text-sm font-medium text-foreground">No documents uploaded</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Upload statements or contracts above to secure them for this {isAccount ? "account" : "investment"}.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {documents.map((doc: any) => (
              <div
                key={doc.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between rounded-xl border border-border p-4 bg-card hover:bg-muted/5 transition-colors gap-4"
              >
                {/* File Details & Icon */}
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex-shrink-0">{getFileIcon(doc.mime_type)}</div>
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-foreground truncate max-w-[280px] sm:max-w-[400px]">
                      {doc.name}
                    </h4>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground mt-1">
                      <span>{formatBytes(doc.file_size)}</span>
                      <span>•</span>
                      <span>{new Date(doc.created_at).toLocaleDateString()}</span>
                      {doc.notes && (
                        <>
                          <span>•</span>
                          <span className="italic truncate max-w-[150px] sm:max-w-[250px]" title={doc.notes}>
                            "{doc.notes}"
                          </span>
                        </>
                      )}
                    </div>

                    {/* Metadata rendering */}
                    <div className="mt-2.5 flex flex-wrap gap-1.5 items-center">
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-primary/10 text-primary border border-primary/20">
                        {investment.name}
                      </span>
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground border border-border">
                        {(investment.asset_type || investment.type || "generic").toUpperCase()}
                      </span>
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 border border-green-500/20">
                        {formatCurrency(
                          investment.current_value !== undefined
                            ? investment.current_value
                            : (investment.balance ?? 0),
                          investment.currency
                        )}
                      </span>
                      {investment.units && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {investment.units} units
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 sm:self-center self-end">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs gap-1.5"
                    onClick={() => handleOpenFile(doc.id)}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    View File
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs text-red-500 hover:text-red-600 hover:bg-red-50/10"
                    onClick={() => handleDelete(doc.id, doc.name)}
                    disabled={deleting}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
