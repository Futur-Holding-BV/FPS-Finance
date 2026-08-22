import { type ElementType, useState } from "react";
import { 
  useListFinanceSalesInvoices, 
  useListFinanceSalesInvoiceImportStatuses, 
  useRunFinanceSalesInvoiceImport, 
  useFinanceMe,
  getListFinanceSalesInvoicesQueryKey,
  getListFinanceSalesInvoiceImportStatusesQueryKey,
  type FinanceSalesInvoiceSource,
  type FinanceSalesInvoiceImportStatus
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate } from "@/lib/utils";
import { 
  FileText, 
  RefreshCw, 
  FileWarning, 
  HardDriveDownload,
  Search,
  Server,
  CloudCog,
  AlertCircle
} from "lucide-react";
import { Input } from "@/components/ui/input";

const formatCurrency = (amount: number, currency: string = 'EUR') => {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: currency,
  }).format(amount);
};

const formatDateOnly = (date: string | null | undefined) => {
  if (!date) return '-';
  return new Intl.DateTimeFormat('nl-NL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(new Date(date));
};

const getInvoiceStatusBadge = (status: string) => {
  switch (status) {
    case 'draft': return <Badge variant="secondary">Concept</Badge>;
    case 'issued': return <Badge variant="default">Verzonden</Badge>;
    case 'paid': return <Badge variant="success">Betaald</Badge>;
    case 'cancelled': return <Badge variant="destructive">Geannuleerd</Badge>;
    case 'credit': return <Badge variant="outline">Credit</Badge>;
    default: return <Badge variant="outline">{status}</Badge>;
  }
};

const getStatusBadge = (state: string) => {
  switch(state) {
    case 'healthy': return <Badge variant="success" className="text-sm px-3 py-1">Gezond</Badge>;
    case 'degraded': return <Badge variant="warning" className="text-sm px-3 py-1">Gedegradeerd</Badge>;
    case 'never-run': return <Badge variant="secondary" className="text-sm px-3 py-1">Nooit uitgevoerd</Badge>;
    default: return <Badge>{state}</Badge>;
  }
};

function ImportCard({ 
  title, 
  source, 
  icon: Icon,
  status, 
  isLoading, 
  onRun, 
  isRunning, 
  hasPermission,
  loadError,
}: { 
  title: string, 
  source: FinanceSalesInvoiceSource, 
  icon: ElementType,
  status?: FinanceSalesInvoiceImportStatus, 
  isLoading: boolean, 
  onRun: (source: FinanceSalesInvoiceSource) => void, 
  isRunning: boolean, 
  hasPermission: boolean,
  loadError: boolean,
}) {
  if (isLoading) {
    return (
      <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
        <CardHeader>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card className="border-none shadow-sm ring-1 ring-red-200 dark:ring-red-900">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Icon className="h-5 w-5 text-red-600" />
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3 rounded-lg border border-red-100 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/30 dark:bg-red-900/10 dark:text-red-400">
            <FileWarning className="h-5 w-5 shrink-0" />
            <p data-testid={`status-import-load-error-${source}`}>
              De importstatus kon niet worden geladen. Vernieuw de pagina en probeer opnieuw.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const isConfigured = status?.configured ?? false;

  return (
    <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800 flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Icon className="w-5 h-5 text-primary" />
          {title}
        </CardTitle>
        <CardDescription>
          Koppeling met {title} voor het ophalen van facturen.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 flex-1">
        {!isConfigured ? (
          <div className="flex flex-col items-center justify-center py-6 text-center text-slate-500 gap-2 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-100 dark:border-slate-800">
            <AlertCircle className="w-8 h-8 text-slate-400" />
            <p className="text-sm">Deze koppeling is niet geconfigureerd in je omgeving.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between py-3 border-b border-slate-100 dark:border-slate-800">
              <span className="text-sm font-medium text-slate-500">Connectiestatus</span>
              {status ? getStatusBadge(status.state) : <Badge variant="secondary">Onbekend</Badge>}
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                <p className="text-xs text-slate-500 mb-1">Laatste poging</p>
                <p className="font-medium text-sm text-slate-900 dark:text-slate-100" data-testid={`last-attempt-${source}`}>
                  {status?.lastAttemptAt ? formatDate(status.lastAttemptAt) : 'Nooit'}
                </p>
              </div>
              <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                <p className="text-xs text-slate-500 mb-1">Laatste succes</p>
                <p className="font-medium text-sm text-slate-900 dark:text-slate-100" data-testid={`last-success-${source}`}>
                  {status?.lastSuccessAt ? formatDate(status.lastSuccessAt) : 'Nooit'}
                </p>
              </div>
            </div>

            {status?.message && status.state !== 'healthy' && (
              <div className="bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 p-3 rounded-lg flex gap-3 text-red-800 dark:text-red-400 text-sm">
                <FileWarning className="w-5 h-5 shrink-0" />
                <p data-testid={`status-import-message-${source}`}>{status.message}</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
      <CardFooter className="bg-slate-50 dark:bg-slate-900 rounded-b-lg border-t border-slate-200 dark:border-slate-800 p-4 mt-auto">
        <Button 
          onClick={() => onRun(source)} 
          disabled={isRunning || !isConfigured || !hasPermission}
          className="w-full gap-2"
          data-testid={`button-run-import-${source}`}
        >
          {isRunning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <HardDriveDownload className="w-4 h-4" />}
          {isRunning ? "Bezig met importeren..." : "Importeer Nu"}
        </Button>
      </CardFooter>
    </Card>
  );
}

export default function SalesInvoices() {
  const { data: me } = useFinanceMe();
  const hasImportPermission = me?.permissions?.includes('finance.invoices.import') ?? false;

  const {
    data: invoices,
    isLoading: invoicesLoading,
    isError: invoicesError,
  } = useListFinanceSalesInvoices();
  const {
    data: statuses,
    isLoading: statusesLoading,
    isError: statusesError,
  } = useListFinanceSalesInvoiceImportStatuses();
  const connectImport = useRunFinanceSalesInvoiceImport();
  const onePlatformImport = useRunFinanceSalesInvoiceImport();
  
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");

  const handleRunImport = (source: FinanceSalesInvoiceSource) => {
    const runImport = source === "fps-connect" ? connectImport : onePlatformImport;
    runImport.mutate({ source }, {
      onSuccess: (result) => {
        toast({
          variant: result.state === "degraded" ? "destructive" : "default",
          title: result.state === "degraded"
            ? `Import niet voltooid voor ${source === "fps-connect" ? "Connect" : "One Platform"}`
            : `Import voltooid voor ${source === "fps-connect" ? "Connect" : "One Platform"}`,
          description: `Status: ${result.state}. Verwerkt: ${result.processed}, Gewijzigd: ${result.changed}, Overgeslagen: ${result.skipped}.`,
        });
        queryClient.invalidateQueries({ queryKey: getListFinanceSalesInvoicesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListFinanceSalesInvoiceImportStatusesQueryKey() });
      },
      onError: (error) => {
        toast({
          variant: "destructive",
          title: "Import mislukt",
          description: error.data?.error || "Er is een onbekende fout opgetreden bij het importeren.",
        });
      }
    });
  };

  const connectStatus = statuses?.find(s => s.source === 'fps-connect');
  const onePlatformStatus = statuses?.find(s => s.source === 'fps-one-platform');

  const filteredInvoices = invoices?.filter(invoice => 
    invoice.invoiceNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
    invoice.customerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    invoice.administrationName.toLowerCase().includes(searchTerm.toLowerCase())
  ) || [];

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Verkoopfacturen</h1>
        <p className="text-slate-500 mt-1">Beheer en importeer verkoopfacturen vanuit gekoppelde systemen.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <ImportCard 
          title="FPS Connect"
          source="fps-connect"
          icon={Server}
          status={connectStatus}
          isLoading={statusesLoading}
          loadError={statusesError}
          onRun={handleRunImport}
          isRunning={connectImport.isPending}
          hasPermission={hasImportPermission}
        />
        
        <ImportCard 
          title="FPS One Platform"
          source="fps-one-platform"
          icon={CloudCog}
          status={onePlatformStatus}
          isLoading={statusesLoading}
          loadError={statusesError}
          onRun={handleRunImport}
          isRunning={onePlatformImport.isPending}
          hasPermission={hasImportPermission}
        />
      </div>

      <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
        <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <CardTitle>Geïmporteerde facturen</CardTitle>
            <CardDescription>Overzicht van alle verkoopfacturen in de lokale Finance database.</CardDescription>
          </div>
          <div className="w-full sm:w-72">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
              <Input 
                type="search" 
                placeholder="Zoek op factuurnummer of klant..." 
                className="pl-9 bg-slate-50 dark:bg-slate-900" 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                data-testid="input-search-sales-invoices"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="border-t border-slate-200 dark:border-slate-800">
            {invoicesLoading ? (
              <div className="p-6 space-y-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : invoicesError ? (
              <div className="flex flex-col items-center justify-center p-12 text-center">
                <FileWarning className="mb-4 h-12 w-12 text-red-400" />
                <h3 className="text-lg font-medium text-slate-900 dark:text-slate-100">
                  Facturen konden niet worden geladen
                </h3>
                <p className="mt-1 max-w-sm text-slate-500" data-testid="status-invoices-load-error">
                  Vernieuw de pagina. Bestaande bronstatussen blijven afzonderlijk beschikbaar.
                </p>
              </div>
            ) : filteredInvoices.length === 0 ? (
              <div className="p-12 text-center flex flex-col items-center justify-center">
                <FileText className="h-12 w-12 text-slate-300 mb-4" />
                <h3 className="text-lg font-medium text-slate-900 dark:text-slate-100">Geen facturen gevonden</h3>
                <p className="text-slate-500 max-w-sm mt-1">
                  {searchTerm 
                    ? "Er zijn geen facturen die overeenkomen met je zoekopdracht." 
                    : "Er zijn nog geen facturen geïmporteerd. Start een import via een van de koppelingen hierboven."}
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader className="bg-slate-50/50 dark:bg-slate-900/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[100px]">Bron</TableHead>
                    <TableHead>Factuurnummer</TableHead>
                    <TableHead>Administratie</TableHead>
                    <TableHead>Klant</TableHead>
                    <TableHead>Datum</TableHead>
                    <TableHead className="text-right">Bedrag</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredInvoices.map((invoice) => (
                    <TableRow key={invoice.id} data-testid={`row-sales-invoice-${invoice.id}`}>
                      <TableCell data-testid={`text-invoice-source-${invoice.id}`}>
                        {invoice.source === 'fps-connect' ? (
                          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600 bg-slate-100 px-2 py-1 rounded w-fit">
                            <Server className="w-3 h-3" />
                            CONN
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-xs font-medium text-blue-600 bg-blue-50 px-2 py-1 rounded w-fit">
                            <CloudCog className="w-3 h-3" />
                            ONE
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-slate-900 dark:text-slate-100">
                        <div className="font-medium" data-testid={`invoice-number-${invoice.id}`}>
                          {invoice.invoiceNumber}
                        </div>
                        <div className="mt-1 max-w-56 truncate font-mono text-[11px] text-slate-400" title={`${invoice.sourceDocumentId} · ${invoice.sourceVersion}`}>
                          Bron-ID {invoice.sourceDocumentId} · versie {invoice.sourceVersion}
                        </div>
                      </TableCell>
                      <TableCell className="text-slate-500" data-testid={`text-invoice-administration-${invoice.id}`}>
                        <div>{invoice.administrationName}</div>
                        {invoice.sourceAdministrationId && (
                          <div className="mt-1 font-mono text-[11px] text-slate-400">
                            Bronadministratie {invoice.sourceAdministrationId}
                          </div>
                        )}
                      </TableCell>
                      <TableCell data-testid={`text-invoice-customer-${invoice.id}`}>
                        {invoice.customerName}
                      </TableCell>
                      <TableCell className="text-slate-500 whitespace-nowrap">
                        {formatDateOnly(invoice.issueDate)}
                      </TableCell>
                      <TableCell className="text-right font-medium" data-testid={`text-invoice-total-${invoice.id}`}>
                        {formatCurrency(invoice.totalAmount, invoice.currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end" data-testid={`invoice-status-${invoice.id}`}>
                          {getInvoiceStatusBadge(invoice.status)}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
