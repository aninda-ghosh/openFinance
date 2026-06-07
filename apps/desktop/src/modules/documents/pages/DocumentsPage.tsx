import { useState, useMemo } from "react";
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
  Search,
  PlusCircle,
  Database,
} from "lucide-react";
import {
  useDocumentsList,
  useUploadDocumentMutation,
  useDeleteDocumentMutation,
} from "../hooks";
import { useInvestments } from "@/modules/investments/hooks/useInvestments";
import { useAccounts } from "@/modules/budget/hooks/useBudget";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { BASE_URL, getToken } from "@/lib/api";
import { formatCurrency } from "@openfinance/shared/utils";
import { isTauri } from "@/lib/utils";

export default function DocumentsPage() {
  const { data: docsData, isLoading: loadingDocs } = useDocumentsList();
  const { data: investmentsData } = useInvestments();
  const { data: accountsData } = useAccounts();

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

  const [searchTerm, setSearchTerm] = useState("");
  const [selectedType, setSelectedType] = useState<string>("all");
  const [selectedParentGroup, setSelectedParentGroup] = useState<string>("all");

  // Direct upload form state
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [targetType, setTargetType] = useState<"investment" | "account">("investment");
  const [targetId, setTargetId] = useState("");
  const [docName, setDocName] = useState("");
  const [docNotes, setDocNotes] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const documents = docsData?.documents || [];
  const investments = investmentsData?.investments || [];
  const accounts = accountsData?.accounts || [];

  // Formats bytes safely
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  // KPI Calculations
  const metrics = useMemo(() => {
    const totalFiles = documents.length;
    const totalSize = documents.reduce((sum, doc) => sum + doc.file_size, 0);
    const pdfCount = documents.filter(d => d.mime_type.includes("pdf")).length;
    const sheetCount = documents.filter(d => 
      d.mime_type.includes("sheet") || d.mime_type.includes("excel") || d.mime_type.includes("csv")
    ).length;
    const imageCount = documents.filter(d => d.mime_type.includes("image")).length;
    const otherCount = totalFiles - pdfCount - sheetCount - imageCount;

    return {
      totalFiles,
      totalSize: formatBytes(totalSize),
      pdfCount,
      sheetCount,
      imageCount,
      otherCount,
    };
  }, [documents]);

  // Resolves custom Lucide file icon
  const getFileIcon = (mimeType: string) => {
    if (mimeType.includes("pdf")) {
      return <FileText className="w-9 h-9 text-rose-500" />;
    }
    if (mimeType.includes("image")) {
      return <ImageIcon className="w-9 h-9 text-blue-500" />;
    }
    if (
      mimeType.includes("sheet") ||
      mimeType.includes("excel") ||
      mimeType.includes("csv")
    ) {
      return <FileSpreadsheet className="w-9 h-9 text-emerald-500" />;
    }
    return <FileIcon className="w-9 h-9 text-muted-foreground" />;
  };

  // Filtered documents
  const filteredDocs = useMemo(() => {
    return documents.filter((doc) => {
      // 1. Search text matching
      const matchesSearch =
        doc.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (doc.notes && doc.notes.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (doc.investment_name && doc.investment_name.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (doc.account_name && doc.account_name.toLowerCase().includes(searchTerm.toLowerCase()));

      if (!matchesSearch) return false;

      // 2. File type matching
      if (selectedType !== "all") {
        const isPdf = doc.mime_type.includes("pdf");
        const isImage = doc.mime_type.includes("image");
        const isSheet = doc.mime_type.includes("sheet") || doc.mime_type.includes("excel") || doc.mime_type.includes("csv");
        
        if (selectedType === "pdf" && !isPdf) return false;
        if (selectedType === "image" && !isImage) return false;
        if (selectedType === "sheet" && !isSheet) return false;
        if (selectedType === "other" && (isPdf || isImage || isSheet)) return false;
      }

      // 3. Parent category matching
      if (selectedParentGroup !== "all") {
        if (selectedParentGroup === "investments" && !doc.investment_id) return false;
        if (selectedParentGroup === "accounts" && !doc.account_id) return false;
      }

      return true;
    });
  }, [documents, searchTerm, selectedType, selectedParentGroup]);

  // Upload handler
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
      toast.error("Please select a file to upload.");
      return;
    }
    if (!targetId) {
      toast.error("Please choose a target holding or account.");
      return;
    }

    uploadDoc(
      {
        parentId: targetType === "account" ? { accountId: targetId } : { investmentId: targetId },
        name: docName || selectedFile.name,
        file: selectedFile,
        notes: docNotes || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Document attached successfully!");
          setSelectedFile(null);
          setDocName("");
          setDocNotes("");
          setTargetId("");
          setShowUploadForm(false);
        },
        onError: (err) => {
          toast.error(err.message || "Failed to attach document.");
        },
      }
    );
  };

  // Delete handler
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
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* ─── Premium Header ─── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-foreground via-foreground/90 to-muted-foreground bg-clip-text text-transparent">
            Secure Document Storage
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage brokerage contract notes, bank statements, policies, and receipts securely in one offline vault.
          </p>
        </div>
        <Button
          onClick={() => setShowUploadForm(!showUploadForm)}
          className="h-10 text-xs font-semibold gap-1.5 self-start md:self-auto bg-primary hover:bg-primary/95 text-primary-foreground shadow-md shadow-primary/10 transition-all active:scale-[0.98]"
        >
          <PlusCircle className="w-4 h-4" />
          {showUploadForm ? "Close Form" : "Attach New Document"}
        </Button>
      </div>

      {/* ─── Summary Dashboard Metrics ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card/40 backdrop-blur-sm border-border/40">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Files</p>
              <h3 className="text-xl font-bold mt-1 tabular-nums">{metrics.totalFiles}</h3>
            </div>
            <div className="p-2.5 rounded-lg bg-primary/5 text-primary">
              <Database className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 backdrop-blur-sm border-border/40">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Storage Used</p>
              <h3 className="text-xl font-bold mt-1 tabular-nums">{metrics.totalSize}</h3>
            </div>
            <div className="p-2.5 rounded-lg bg-emerald-500/5 text-emerald-500">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 backdrop-blur-sm border-border/40">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">PDF Statements</p>
              <h3 className="text-xl font-bold mt-1 tabular-nums">{metrics.pdfCount}</h3>
            </div>
            <div className="p-2.5 rounded-lg bg-rose-500/5 text-rose-500">
              <FileText className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 backdrop-blur-sm border-border/40">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Spreadsheets & Images</p>
              <h3 className="text-xl font-bold mt-1 tabular-nums">
                {metrics.sheetCount + metrics.imageCount}
              </h3>
            </div>
            <div className="p-2.5 rounded-lg bg-blue-500/5 text-blue-500">
              <ImageIcon className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ─── Dynamic Attachment Form ─── */}
      {showUploadForm && (
        <form onSubmit={handleUploadSubmit} className="space-y-4 rounded-2xl border border-border p-5 bg-card/60 backdrop-blur-md shadow-xl transition-all">
          <h3 className="text-sm font-semibold tracking-tight uppercase text-muted-foreground">
            Attach Document to Vault
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Pick parent category */}
            <div className="space-y-1.5">
              <Label htmlFor="target-type">Attach Category</Label>
              <select
                id="target-type"
                value={targetType}
                onChange={(e) => {
                  setTargetType(e.target.value as any);
                  setTargetId("");
                }}
                className="w-full border border-border bg-background rounded-lg px-3 py-2 text-sm h-10 focus:ring-1 focus:ring-primary"
              >
                <option value="investment">Investment / Holding</option>
                <option value="account">Standard Account (Budget/Balance Sheet)</option>
              </select>
            </div>

            {/* Pick parent target */}
            <div className="space-y-1.5">
              <Label htmlFor="target-id">Select Target Destination</Label>
              <select
                id="target-id"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="w-full border border-border bg-background rounded-lg px-3 py-2 text-sm h-10 focus:ring-1 focus:ring-primary"
                required
              >
                <option value="">-- Choose Account/Holding --</option>
                {targetType === "investment"
                  ? investments.map((inv: any) => (
                      <option key={inv.id} value={inv.id}>
                        {inv.name} ({inv.currency})
                      </option>
                    ))
                  : accounts.map((acc: any) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({acc.type} - {acc.currency})
                      </option>
                    ))}
              </select>
            </div>

            {/* Pick File */}
            <div className="space-y-1.5">
              <Label>Statement File</Label>
              <div className="relative">
                <input
                  type="file"
                  onChange={handleFileChange}
                  accept=".pdf,.png,.jpg,.jpeg,.gif,.csv,.xls,.xlsx"
                  className="hidden"
                  id="direct-file-input"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="w-full h-10 text-xs border-dashed justify-center truncate"
                  onClick={() => document.getElementById("direct-file-input")?.click()}
                >
                  <UploadCloud className="w-4 h-4 mr-2" />
                  {selectedFile ? selectedFile.name : "Select Document File"}
                </Button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="direct-doc-name">Display Title</Label>
              <Input
                id="direct-doc-name"
                placeholder="e.g. Q1 brokerage notes, May bank stmt"
                value={docName}
                onChange={(e) => setDocName(e.target.value)}
                maxLength={100}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="direct-doc-notes">Description / Remarks</Label>
              <Input
                id="direct-doc-notes"
                placeholder="e.g. Generated automatically from portal"
                value={docNotes}
                onChange={(e) => setDocNotes(e.target.value)}
                maxLength={200}
              />
            </div>
          </div>

          <Button
            type="submit"
            className="w-full h-10 font-semibold text-xs"
            disabled={uploading || !selectedFile || !targetId}
          >
            {uploading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Encrypting and attaching file...
              </>
            ) : (
              "Secure File in Vault"
            )}
          </Button>
        </form>
      )}

      {/* ─── Search & Filters Control Panel ─── */}
      <Card className="bg-card/20 border-border/40 p-4 shadow-sm">
        <div className="flex flex-col md:flex-row items-center gap-3 justify-between">
          {/* Search bar */}
          <div className="relative w-full md:w-96 flex-shrink-0">
            <Search className="absolute left-3 top-3 h-4 h-4 text-muted-foreground/60" />
            <Input
              placeholder="Search file name, notes, or parent holding..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 h-10 text-sm bg-background border-border/40"
            />
          </div>

          {/* Toggle Type Filters */}
          <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
            {/* Filter class type */}
            <div className="flex items-center rounded-lg border border-border/50 bg-background/50 p-0.5 text-xs">
              {(["all", "pdf", "sheet", "image", "other"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setSelectedType(t)}
                  className={`px-3 py-1.5 rounded-md capitalize font-semibold transition-colors ${
                    selectedType === t
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t === "all" ? "All Formats" : t === "sheet" ? "Sheets" : t === "image" ? "Images" : t}
                </button>
              ))}
            </div>

            {/* Filter Parent Source */}
            <select
              value={selectedParentGroup}
              onChange={(e) => setSelectedParentGroup(e.target.value)}
              className="border border-border/50 bg-background/50 rounded-lg px-2.5 py-1.5 text-xs font-semibold h-[34px] focus:ring-1 focus:ring-primary select-none cursor-pointer"
            >
              <option value="all">All Sources</option>
              <option value="investments">Investments Only</option>
              <option value="accounts">Accounts Only</option>
            </select>
          </div>
        </div>
      </Card>

      {/* ─── Master Vault List ─── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold tracking-wider uppercase text-muted-foreground">
            Master Secure Directory
          </h3>
          <span className="text-xs text-muted-foreground font-mono">
            Showing {filteredDocs.length} matching files
          </span>
        </div>

        {loadingDocs ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : filteredDocs.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 p-12 bg-muted/5 text-center">
            <FileIcon className="w-12 h-12 text-muted-foreground/45 mb-2" />
            <p className="text-sm font-semibold text-foreground">No documents matching filters</p>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-[340px]">
              Try clearing your search term, adjusting filters, or upload a bank statement above to attach it.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {filteredDocs.map((doc: any) => {
              // Resolve metadata dynamically based on joined account or investment
              const parentName = doc.investment_name || doc.account_name || "—";
              const parentCategory = doc.investment_id 
                ? (doc.investment_asset_type || "HOLDING").toUpperCase() 
                : (doc.account_type || "ACCOUNT").toUpperCase();
              const parentCurrency = doc.investment_currency || doc.account_currency || "INR";
              const parentValue = doc.investment_id 
                ? (doc.investment_current_value ?? 0) 
                : (doc.account_balance ?? 0);
              
              const isInvestment = !!doc.investment_id;

              return (
                <div
                  key={doc.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between rounded-2xl border border-border/50 p-4 bg-card hover:bg-muted/5 transition-colors gap-4 shadow-sm"
                >
                  <div className="flex items-start gap-4">
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

                      {/* Parent badging */}
                      <div className="mt-2.5 flex flex-wrap gap-1.5 items-center">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${
                          isInvestment 
                            ? "bg-violet-500/10 text-violet-500 border-violet-500/20" 
                            : "bg-blue-500/10 text-blue-500 border-blue-500/20"
                        }`}>
                          {parentName}
                        </span>
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground border border-border">
                          {parentCategory}
                        </span>
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 border border-green-500/20">
                          {formatCurrency(parentValue, parentCurrency)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Quick Action buttons */}
                  <div className="flex items-center gap-2 sm:self-center self-end">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs gap-1.5"
                      onClick={() => handleOpenFile(doc.id)}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Open File
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
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
