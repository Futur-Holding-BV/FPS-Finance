import {
  getFinanceMeQueryKey,
  getListFinanceAuditEventsQueryKey,
  useFinanceMe,
  useListFinanceAuditEvents,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/lib/utils";
import { Info, ScrollText } from "lucide-react";

export default function ControlLog() {
  const { data: me } = useFinanceMe({ query: { queryKey: getFinanceMeQueryKey(), retry: false } });
  const canViewAudit = (me?.permissions ?? []).includes("finance.audit.view");
  const { data: events, isLoading } = useListFinanceAuditEvents({
    query: {
      queryKey: getListFinanceAuditEventsQueryKey(),
      enabled: canViewAudit,
    },
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Controlelog</h1>
        <p className="text-slate-500 mt-1">Alleen-lezen historisch bewijs van echte, eerder vastgelegde gebeurtenissen.</p>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
        <Info className="mt-0.5 h-5 w-5 shrink-0" />
        <p>
          Betalen en periodes afsluiten is niet beschikbaar in deze Finance-stam.
          Hiervoor is eerst echte financiële verwerkingslogica nodig; het controlelog kan geen actie als voltooid melden.
        </p>
      </div>

      <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg"><ScrollText className="h-5 w-5 text-primary" /> Append-only controlelog</CardTitle>
          <CardDescription>Bestaande records blijven ongewijzigd beschikbaar voor controle.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!canViewAudit ? (
            <p className="p-6 text-sm text-slate-500">Je hebt geen recht om het controlelog te bekijken.</p>
          ) : isLoading ? (
            <Skeleton className="m-6 h-48" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Historische actie</TableHead>
                  <TableHead>Administratie</TableHead>
                  <TableHead>Referentie</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Uitgevoerd</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(events ?? []).length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="py-10 text-center text-slate-500">Geen historische controlelogrecords.</TableCell></TableRow>
                ) : (events ?? []).map((event) => (
                  <TableRow key={event.id} data-testid={`row-audit-${event.id}`}>
                    <TableCell><Badge variant="outline">{event.action === "payment_executed" ? "Betaling" : "Periodeafsluiting"}</Badge></TableCell>
                    <TableCell>{event.administrationName}</TableCell>
                    <TableCell>
                      <div className="font-medium">{event.reference}</div>
                      {event.amount !== null && <div className="text-xs text-slate-500">{event.currency} {event.amount.toFixed(2)}</div>}
                    </TableCell>
                    <TableCell>{event.actorName}</TableCell>
                    <TableCell>{formatDate(event.occurredAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}