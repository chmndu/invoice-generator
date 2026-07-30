"use client"

import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import type { Invoice } from "@/lib/invoice";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { validateForExport } from "@/lib/validate";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toPng } from "html-to-image";
import { InvoicePaper } from "@/components/InvoicePaper";
import { BUSINESS } from "@/config/business";
import { formatRs } from "@/lib/format";
import { Trash2 } from "lucide-react";

const PROFILE_KEY = "invoice_profile_v1";
const INVOICE_DRAFT_KEY = "invoice_draft_v1"; // autosave
const INVOICE_PRINT_KEY = "invoice_print_v1"; // used only for /print
const INVOICE_COUNTER_KEY = "invoice_counter_v1"; // for sequential numbers
const PAPER_W = 794;
const PAPER_H = 1123;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function invoiceYear(dateISO: string) {
  const y = Number((dateISO || todayISO()).slice(0, 4));
  return Number.isFinite(y) ? y : new Date().getFullYear();
}

function pad4(n: number) {
  return String(Math.min(Math.max(Math.floor(n), 0), 9999)).padStart(4, "0");
}

function counterKey(year: number) {
  return `${INVOICE_COUNTER_KEY}:${year}`;
}

// reads last-used for that year
function readCounter(year: number) {
  const raw = localStorage.getItem(counterKey(year));
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

// writes last-used for that year
function writeCounter(year: number, lastUsed: number) {
  localStorage.setItem(counterKey(year), String(Math.min(Math.max(Math.floor(lastUsed), 0), 9999)));
}

function extractSeq(invoiceNo: string) {
  const m = invoiceNo.match(/(\d{1,4})$/);
  return m ? Number(m[1]) : 0;
}

function formatInvoiceNo(year: number, seq: number) {
  return `INV-${year}-${pad4(seq)}`;
}

function nextInvoiceNumber(year: number) {
  const next = readCounter(year) + 1;
  writeCounter(year, next);
  return formatInvoiceNo(year, next);
}

function slugify(s: string) {
  return s
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-_]/g, "")
    .slice(0, 30);
}

function buildFileName(invoice: Invoice, ext: "png" | "pdf") {
  const parts = [
    invoice.invoiceNumber,
    invoice.date || "draft",
  ];

  const customer = slugify(invoice.customerName || "");
  if (customer) parts.push(customer);

  return `${parts.join("_")}.${ext}`;
}

export default function Home() {
  const [invoice, setInvoice] = useState<Invoice>(() => {
    const defaults: Invoice ={
      date: new Date().toISOString().slice(0, 10),
      items: [
        {
          id: crypto.randomUUID(),
          description: "",
          size: "",
          quantity: 1,
          unitPrice: 0,
        },
      ],
      discount: null,
      showBankDetails: false,
      bankDetails: {
        name: "",
        accountNumber: "",
        bank: "",
        branch: "",
      },
      business: BUSINESS,
      invoiceNumber: `INV-${new Date().getFullYear()}-1001`,
      customerName: "",
      showTotalInWords: false,
    };

    //only runs in the browser
    if (typeof window === "undefined") return defaults;

    try {
      // Load profile (bank settings)
      const rawProfile = localStorage.getItem(PROFILE_KEY);
      const savedProfile = rawProfile
        ? (JSON.parse(rawProfile) as {
            showBankDetails?: boolean;
            bankDetails?: Partial<Invoice["bankDetails"]>;
          })
        : null;

      const withProfile: Invoice = {
        ...defaults,
        showBankDetails: savedProfile?.showBankDetails ?? defaults.showBankDetails,
        bankDetails: { ...defaults.bankDetails, ...(savedProfile?.bankDetails ?? {}) },
      };

      // Load draft (full invoice)
      const rawDraft = localStorage.getItem(INVOICE_DRAFT_KEY);
      if (!rawDraft) return withProfile;

      const draft = JSON.parse(rawDraft) as Invoice;

      // Draft wins for editable fields, but keep safe base shape
      return { ...withProfile, ...draft };
    } catch {
      return defaults;
    }
  });
  const [exportErrors, setExportErrors] = useState<string[]>([]);
  const [previewScale, setPreviewScale] = useState(1);
  const [invSeqDraft, setInvSeqDraft] = useState(""); // what user is typing (0–4 digits)
  const [invSeqEditing, setInvSeqEditing] = useState(false);

  const exportRef = useRef<HTMLDivElement | null>(null);
  const previewWrapRef = useRef<HTMLDivElement | null>(null);
  const discountTypeTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(
        PROFILE_KEY,
        JSON.stringify({
          showBankDetails: invoice.showBankDetails,
          bankDetails: invoice.bankDetails,
        })
      );
    } catch {
      // ignore storage errors
    }
  }, [invoice.showBankDetails, invoice.bankDetails]);

  useEffect(() => {
    try {
      localStorage.setItem(INVOICE_DRAFT_KEY, JSON.stringify(invoice));
    } catch {
      // ignore
    }
  }, [invoice]);

  useEffect(() => {
    const el = previewWrapRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? PAPER_W;
      const scale = Math.min(1, width / PAPER_W);
      setPreviewScale(scale);
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const addItem = () => {
    const newItem = {
      id: crypto.randomUUID(),
      description: "",
      size: "",
      quantity: 1,
      unitPrice: 0,
    };

    setInvoice((prev) => ({
      ...prev,
      items: [...prev.items, newItem],
    }));
  };

  const updateItem = (index: number, patch: Partial<(typeof invoice.items)[number]>) => {
    setInvoice((prev) => {
      const items = [...prev.items];
      items[index] = {...items[index], ...patch};
      return {...prev, items};
    });
  };

  const updateBankDetails = (
    patch: Partial<Invoice["bankDetails"]>
  ) => {
    setInvoice((prev) => ({
      ...prev,
      bankDetails: { ...prev.bankDetails, ...patch },
    }));
  }

  const removeItem = (index: number) => {
    setInvoice((prev) => {
      if(prev.items.length <= 1) return prev; // Prevent removing the last item
      const items = prev.items.filter((_, i) => i !== index);
      return {...prev, items};
    })
  }

  const runExport = async (kind: "pdf" | "png") => {
    const errors = validateForExport(invoice);

    if (errors.length > 0) {
      setExportErrors(errors);
      return;
    }

    setExportErrors([]);

    if (kind === "png") {
      const node = exportRef.current;
      if (!node) return;

      try {
        const dataUrl = await toPng(node, {
          pixelRatio: 2,
          cacheBust: true,
          backgroundColor: "#ffffff",
        });

        const link = document.createElement("a");
        link.download = buildFileName(invoice, "png");
        link.href = dataUrl;
        link.click();
      } catch (err) {
        console.error(err);
        setExportErrors(["PNG export failed. Please try again."]);
      }

      return;
    }

    if (kind === "pdf") {
      try {
        localStorage.setItem(INVOICE_PRINT_KEY, JSON.stringify(invoice));
        window.open("/print", "_blank", "noopener,noreferrer");
      } catch {
        setExportErrors(["PDF export failed. Please try again."]);
      }
      return;
    }
  }

  const commitInvSeq = () => {
    const year = invoiceYear(invoice.date);

    // if user hasn't typed anything, just exit edit mode
    if (!invSeqEditing) return;

    const digits = invSeqDraft.replace(/\D/g, "").slice(0, 4);
    if (!digits) {
      setInvSeqEditing(false);
      setInvSeqDraft("");
      return;
    }

    const padded = digits.padStart(4, "0");
    const n = Number(padded);

    try {
      writeCounter(year, n); // allow backwards too (your rule)
    } catch {}

    setInvoice((prev) => ({ ...prev, invoiceNumber: formatInvoiceNo(year, n) }));
    setInvSeqEditing(false);
    setInvSeqDraft("");
  };

  const newInvoice = () => {
    commitInvSeq();
    setExportErrors([]);

    const year = invoiceYear(invoice.date);

    // sync counter from the CURRENT invoice number (so next continues from it)
    try {
      writeCounter(year, extractSeq(invoice.invoiceNumber));
    } catch {}

    const newNo = nextInvoiceNumber(year);
    const newDate = todayISO();

    setInvoice((prev) => ({
      ...prev,
      invoiceNumber: newNo,
      date: newDate,
      customerName: "",
      items: [
        {
          id: crypto.randomUUID(),
          description: "",
          size: "",
          quantity: 1,
          unitPrice: 0,
        },
      ],
      discount: null,
      // keep saved profile
      showBankDetails: prev.showBankDetails,
      bankDetails: prev.bankDetails,
      business: prev.business,
    }));
  };

  return (
    <div className="bg-zinc-50 font-sans dark:bg-black">
      <main className="min-h-dvh p-4">
        <h1 className="text-2xl font-semibold tracking-tight">Invoice Generator</h1>
        <p className="text-sm text-muted-foreground">
          Create invoices and export as PDF or PNG.
        </p>
        
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <section aria-labelledby="editor-title">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle id="editor-title">Editor</CardTitle>
                <div className="flex gap-2">
                  <Button type="button" onClick={addItem}>
                    Add item
                  </Button>
                  <Button type="button" variant="secondary" onClick={newInvoice}>
                    New invoice
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Invoice meta */}
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="inv-no">Invoice No</Label>
                    {(() => {
                      const year = invoiceYear(invoice.date);
                      const currentSeqPadded = pad4(extractSeq(invoice.invoiceNumber));

                      return (
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">{`INV-${year}-`}</span>

                          <Input
                            id="inv-no"
                            className="w-24 tabular-nums"
                            inputMode="numeric"
                            maxLength={4}
                            placeholder="1001"
                            value={invSeqEditing ? invSeqDraft : currentSeqPadded}
                            onFocus={() => {
                              setInvSeqEditing(true);
                              // start editing without leading zeros
                              setInvSeqDraft(String(extractSeq(invoice.invoiceNumber)));
                            }}
                            onChange={(e) => {
                              const digits = e.target.value.replace(/\D/g, "").slice(0, 4);
                              setInvSeqDraft(digits);
                            }}
                            onBlur={commitInvSeq}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitInvSeq();
                                // remove focus so it feels “saved”
                                (e.currentTarget as HTMLInputElement).blur();
                              }
                            }}
                          />
                        </div>
                      );
                    })()}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="inv-date">Date</Label>
                    <Input
                      id="inv-date"
                      type="date"
                      value={invoice.date}
                      onChange={(e) =>
                        setInvoice((prev) => {
                          const newDate = e.target.value;
                          const newYear = invoiceYear(newDate);
                          const seq = extractSeq(prev.invoiceNumber);
                          return {
                            ...prev,
                            date: newDate,
                            invoiceNumber: formatInvoiceNo(newYear, seq),
                          };
                        })
                      }
                    />
                  </div>

                  <div className="space-y-2 sm:col-span-3">
                    <Label htmlFor="customer-name">Customer Name</Label>
                    <Input
                      id="customer-name"
                      value={invoice.customerName}
                      onChange={(e) =>
                        setInvoice((prev) => ({ ...prev, customerName: e.target.value }))
                      }
                      placeholder="e.g. John Doe"
                    />
                  </div>
                </div>

                {/* Items */}
                {invoice.items.map((item, index) => (
                  <div key={item.id} className="space-y-3 border p-4 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="h-4 w-1 rounded bg-primary/30" />
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Item {index + 1}
                        </p>
                      </div>

                      {invoice.items.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => removeItem(index)}
                        >
                          <Trash2 className="h-4 w-4" />
                          Remove item
                        </Button>
                      )}
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor={`desc-${index}`}>Description</Label>
                        <Input
                          id={`desc-${index}`}
                          type="text"
                          value={item.description}
                          onChange={(e) => updateItem(index, { description: e.target.value })}
                          placeholder="e.g. Sofa"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor={`size-${index}`}>Size</Label>
                        <Input
                          id={`size-${index}`}
                          type="text"
                          value={item.size}
                          onChange={(e) => updateItem(index, { size: e.target.value })}
                          placeholder="e.g. 6ft"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor={`qty-${index}`}>Quantity</Label>
                        <Input
                          id={`qty-${index}`}
                          type="number"
                          value={item.quantity}
                          min={1}
                          step={1}
                          inputMode="numeric"
                          onChange={(e) => updateItem(index, { quantity: Math.max(1, Math.floor(Number(e.target.value))) })}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor={`price-${index}`}>Price</Label>
                        <Input
                          id={`price-${index}`}
                          type="number"
                          value={item.unitPrice}
                          min={0}
                          step={1}
                          inputMode="numeric"
                          onChange={(e) => updateItem(index, { unitPrice: Math.max(0, Math.floor(Number(e.target.value))) })}
                        />
                      </div>
                    </div>
                    

                    <p className="text-sm text-muted-foreground">
                      Line total: <span className="tabular-nums">{formatRs(item.quantity * item.unitPrice)}</span>
                    </p>
                  </div>
                ))}

                {/* Discount */}
                <div className="border-t pt-4 space-y-3">
                  {invoice.discount === null ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => 
                        setInvoice((prev) => ({
                          ...prev,
                          discount: { type: "amount", value: 0 },
                        }))
                      }
                    >
                      Add discount
                    </Button>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium">Discount</p>
                        <Button
                          type="button"
                          variant="ghost"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setInvoice((prev) => ({ ...prev, discount: null }))}
                        >
                          Remove discount
                        </Button>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label
                            id="discount-type-label"
                            className="cursor-pointer"
                            onPointerDown={(e) => {
                              e.preventDefault();
                              const el = discountTypeTriggerRef.current;
                              if (!el) return;

                              el.focus();

                              try {
                                el.dispatchEvent(
                                  new PointerEvent("pointerdown", {
                                    bubbles: true,
                                    cancelable: true,
                                    pointerType: "mouse",
                                  })
                                );
                              } catch {
                                el.click();
                              }
                            }}
                          >
                            Type
                          </Label>
                          <Select
                            value={invoice.discount.type}
                            onValueChange={(val) =>
                              setInvoice((prev) => ({
                                ...prev,
                                discount: {
                                  type: val as "amount" | "percent",
                                  value: prev.discount?.value ?? 0,
                                },
                              }))
                            }
                          >
                            <SelectTrigger
                              ref={discountTypeTriggerRef}
                              id="discount-type"
                              aria-labelledby="discount-type-label"
                            >
                              <SelectValue placeholder="Select type" />
                            </SelectTrigger>

                            <SelectContent>
                              <SelectItem value="amount">Rs.</SelectItem>
                              <SelectItem value="percent">%</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        
                        <div className="space-y-2">
                          <Label htmlFor="discount-value">Value</Label>
                          <Input
                            id="discount-value"
                            type="number"
                            inputMode="numeric"
                            min={0}
                            step={1}
                            value={invoice.discount.value}
                            onChange={(e) => {
                              const n = Math.max(0, Math.floor(Number(e.target.value)));
                              const discount = invoice.discount;

                              if(!discount) return;

                              const value = discount.type === "percent" ? Math.min(n, 100) : n; // Cap percentage at 100

                                setInvoice((prev) => ({
                                  ...prev,
                                  discount: { ...discount, value },
                                }));
                            }}
                          />
                          {invoice.discount.type === "percent" && (
                            <p className="text-xs text-muted-foreground">Max 100%</p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Total in words */}
                <div className="flex items-center justify-between border-t pt-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Total in words</p>
                    <p className="text-xs text-muted-foreground">Adds “… Rupees Only” to the invoice</p>
                  </div>

                  <div className="flex items-center gap-2">
                    <Label htmlFor="show-words" className="text-sm">
                      Show
                    </Label>
                    <Switch
                      id="show-words"
                      checked={invoice.showTotalInWords}
                      onCheckedChange={(checked) =>
                        setInvoice((prev) => ({ ...prev, showTotalInWords: checked }))
                      }
                    />
                  </div>
                </div>

                {/* Bank details */}
                <div className="border-t pt-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Account Details</p>
                      <p className="text-xs text-muted-foreground">
                        Saved on this device
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <Label htmlFor="show-bank" className="text-sm">
                        Show
                      </Label>
                      <Switch
                        id="show-bank"
                        checked={invoice.showBankDetails}
                        onCheckedChange={(checked) => 
                          setInvoice((prev) => ({ ...prev, showBankDetails: checked }))
                        }
                      />
                    </div>
                  </div>

                  {invoice.showBankDetails && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="acc-name">Name</Label>
                        <Input
                          id="acc-name"
                          value={invoice.bankDetails.name}
                          onChange={(e) => updateBankDetails({ name: e.target.value })}
                          placeholder="e.g. A. Smith"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="acc-number">Account number</Label>
                        <Input
                          id="acc-number"
                          value={invoice.bankDetails.accountNumber}
                          inputMode="numeric"
                          onChange={(e) => updateBankDetails({ accountNumber: e.target.value })}
                          placeholder="e.g. 0123456789"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="bank-name">Bank</Label>
                        <Input
                          id="bank-name"
                          value={invoice.bankDetails.bank}
                          onChange={(e) => updateBankDetails({ bank: e.target.value })}
                          placeholder="e.g. Lanka Bank"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="bank-branch">Branch</Label>
                        <Input
                          id="bank-branch"
                          value={invoice.bankDetails.branch}
                          onChange={(e) => updateBankDetails({ branch: e.target.value })}
                          placeholder="e.g. Maharagama"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </section>
          <section aria-labelledby="preview-title">
            <Card>
              <CardHeader>
                <CardTitle id="preview-title">Preview</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => runExport("pdf")}>
                    Download PDF
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => runExport("png")}>
                    Download PNG
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">For a clean PDF, disable ‘Headers and footers’ in the print dialog.</p>

                {exportErrors.length > 0 && (
                  <Alert variant="destructive">
                    <AlertTitle>Fix these before exporting</AlertTitle>
                    <AlertDescription>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {exportErrors.map((msg) => (
                          <li key={msg}>{msg}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

                {/* Visible preview (auto-scaled to fit) */}
                <div ref={previewWrapRef} className="w-full border">
                  <div
                    className="relative overflow-hidden rounded-md bg-zinc-100"
                    style={{ height: PAPER_H * previewScale }}
                  >
                    <div
                      className="absolute left-1/2 top-0 origin-top"
                      style={{ transform: `translateX(-50%) scale(${previewScale})` }}
                    >
                      <InvoicePaper invoice={invoice} />
                    </div>
                  </div>
                </div>
              </CardContent>

              {/* Hidden export canvas (always unscaled) */}
              <div className="fixed left-[-99999px] top-0">
                <div ref={exportRef} className="inline-block bg-white">
                  <InvoicePaper invoice={invoice} />
                </div>
              </div>
            </Card>
          </section>
        </div>
      </main>
      
      <footer className="m-4 mt-0 flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>Your data is saved locally in this browser.</span>
        <span className="text-foreground">Built by
          <a
            className="underline underline-offset-4 hover:text-ring font-medium ml-1"
            href="https://github.com/chmndu"
            target="_blank"
            rel="noreferrer"
          >
            Chamindu Dahanayaka
          </a>
        </span>
      </footer>
    </div>
  );
}
