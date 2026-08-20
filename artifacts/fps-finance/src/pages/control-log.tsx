import { useMemo, useState } from "react";
import {
  getFinanceMeQueryKey,
  getListFinanceAuditEventsQueryKey,
  useCloseFinancePeriod,
  useFinanceMe,
  useListFinanceAdministrations,
  useListFinanceAuditEvents,
  useRecordFinancePayment,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/utils";
import { CalendarCheck, CreditCard, Loader2, ScrollText } from "lucide-react";

export default function ControlLog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useFinanceMe({ query: { queryKey: getFinanceMeQueryKey(), retry: false } });
  const { data: administrations, isLoading: administrationsLoading } = useListFinanceAdministrations();
  const permissions = me?.permissions ?? [];
  const canViewAudit = permissions.includes("finance.audit.view");
  const canRecordPayment = permissions.includes("finance.payments.execute");
  const canClosePeriod = permissions.includes("finance.period.close");
  const { data: events, isLoading: eventsLoading } = useListFinanceAuditEvents({
    query: {
      queryKey: getListFinanceAuditEventsQueryKey(),
      enabled: canViewAudit,
    },
  });
  const paymentMutation = useRecordFinancePayment();
  const periodMutation = useCloseFinancePeriod();
  const [administrationId, setAdministrationId] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [amount, setAmount] = useState("");
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));

  const availableAdministrations = useMemo(
    () => (administrations ?? []).filter((administration) => administration.active),
    [administrations],
  );
  const selectedAdministrationId = administrationId || availableAdministrations[0]?.id || "";

  const refreshAudit = async () => {
    await queryClient.invalidateQueries({ queryKey: getListFinanceAuditEventsQueryKey() });
  };

  const recordPayment = () => {
    const numericAmount = Number(amount.replace(",", "."));
    if (!selectedAdministrationId || !paymentReference.trim() || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      toast({ variant: "destructive", title: "Controleer de betaling", description: "Kies een administratie en vul een kenmerk en positief bedrag in." });
      return;
    }
    paymentMutation.mutate({
      data: {
        administrationId: selectedAdministrationId,
        paymentReference: paymentReference.trim(),
        amount: numericAmount,
        currency: "EUR",
      },
    }, {
      onSuccess: async () => {
        setPaymentReference("");
        setAmount("");
        await refreshAudit();
        toast({ title: "Betaling vastgelegd", description: "De actie staat onveranderbaar in het Finance-controlelog." });
      },
      onError: (error) => toast({ variant: "destructive", title: "Vastleggen mislukt", description: error.data?.error ?? "De betaling kon niet worden vastgelegd." }),
    });
  };

  const closePeriod = () => {
    if (!selectedAdministrationId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      toast({ variant: "destructive", title: "Controleer de periode", description: "Kies een administratie en een geldige maand." });
      return;
    }
    periodMutation.mutate({
      data: { administrationId: selectedAdministrationId, period },
    }, {
      onSuccess: async () => {
        await refreshAudit();
        toast({ title: "Periodeafsluiting vastgelegd", description: `${period} staat onveranderbaar in het Finance-controlelog.` });
      },
      onError: (error) => toast({ variant: "destructive", title: "Vastleggen mislukt", description: error.data?.error ?? "De periodeafsluiting kon niet worden vastgelegd." }),
    });
  };

  if (administrationsLoading) {
    return <Skeleton className="h-[560px] rounded-xl" />;
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Controlelog</h1>
        <p className="text-slate-500 mt-1">Onveranderbaar bewijs van betalingen en periodeafsluitingen binnen Finance.</p>
      </div>

      <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
        <CardHeader>
          <CardTitle className="text-lg">Administratie</CardTitle>
          <CardDescription>De gekozen administratie geldt voor de acties hieronder.</CardDescription>
        </CardHeader>
        <CardContent>
          <select
            aria-label="Administratie"
            className="h-10 w-full max-w-lg rounded-md border border-input bg-background px-3 text-sm"
            value={selectedAdministrationId}
            onChange={(event) => setAdministrationId(event.target.value)}
            data-testid="select-audit-administration"
          >
            {availableAdministrations.map((administration) => (
              <option key={administration.id} value={administration.id}>{administration.name}</option>
            ))}
          </select>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg"><CreditCard className="h-5 w-5 text-primary" /> Betaling vastleggen</CardTitle>
            <CardDescription>Registreert dat een betaling is uitgevoerd; dit start zelf geen bankoverschrijving.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input aria-label="Betalingskenmerk" placeholder="Betalingskenmerk" value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} disabled={!canRecordPayment} data-testid="input-payment-reference" />
            <Input aria-label="Bedrag in euro" inputMode="decimal" placeholder="Bedrag in EUR" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={!canRecordPayment} data-testid="input-payment-amount" />
            <Button onClick={recordPayment} disabled={!canRecordPayment || paymentMutation.isPending} data-testid="button-record-payment">
              {paymentMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Leg betaling vast
            </Button>
            {!canRecordPayment && <p className="text-sm text-slate-500">Hiervoor is het recht <code>finance.payments.execute</code> nodig.</p>}
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg"><CalendarCheck className="h-5 w-5 text-primary" /> Periode afsluiten</CardTitle>
            <CardDescription>Legt de uitgevoerde periodeafsluiting met actor en tijdstip vast.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input aria-label="Afsluitperiode" type="month" value={period} onChange={(event) => setPeriod(event.target.value)} disabled={!canClosePeriod} data-testid="input-close-period" />
            <Button onClick={closePeriod} disabled={!canClosePeriod || periodMutation.isPending} data-testid="button-close-period">
              {periodMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Leg periodeafsluiting vast
            </Button>
            {!canClosePeriod && <p className="text-sm text-slate-500">Hiervoor is het recht <code>finance.period.close</code> nodig.</p>}
          </CardContent>
        </Card>
      </div>

      <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg"><ScrollText className="h-5 w-5 text-primary" /> Onveranderbaar controlelog</CardTitle>
          <CardDescription>Alleen Finance-beheerders met <code>finance.audit.view</code> kunnen dit overzicht lezen.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!canViewAudit ? (
            <p className="p-6 text-sm text-slate-500">Je hebt geen recht om het controlelog te bekijken.</p>
          ) : eventsLoading ? (
            <Skeleton className="m-6 h-48" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Actie</TableHead>
                  <TableHead>Administratie</TableHead>
                  <TableHead>Referentie</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Uitgevoerd</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(events ?? []).length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="py-10 text-center text-slate-500">Nog geen controleerbare acties vastgelegd.</TableCell></TableRow>
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