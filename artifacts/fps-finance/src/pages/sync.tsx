import { useGetFinanceSyncStatus, useRunFinanceSync } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw, Activity, ArrowRightLeft, FileWarning, Database, HardDriveDownload } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { getGetFinanceSyncStatusQueryKey, getGetFinanceDashboardQueryKey } from "@workspace/api-client-react";

export default function Sync() {
  const { data: status, isLoading } = useGetFinanceSyncStatus();
  const runSync = useRunFinanceSync();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-64 mb-2" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-[300px] rounded-xl" />
        </div>
      </div>
    );
  }

  const handleRunSync = () => {
    runSync.mutate(undefined, {
      onSuccess: (result) => {
        toast({
          title: "Synchronisatie voltooid",
          description: `Status: ${result.state}. Aangepast: ${result.changed}, Overgeslagen: ${result.skipped}.`,
        });
        queryClient.invalidateQueries({ queryKey: getGetFinanceSyncStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetFinanceDashboardQueryKey() });
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "Synchronisatie mislukt",
          description: err.data?.error || "Er is een onbekende fout opgetreden bij het synchroniseren.",
        });
      }
    });
  };

  const getStatusBadge = (state: string) => {
    switch(state) {
      case 'healthy': return <Badge variant="success" className="text-sm px-3 py-1">Gezond</Badge>;
      case 'degraded': return <Badge variant="warning" className="text-sm px-3 py-1">Gedegradeerd</Badge>;
      case 'never-run': return <Badge variant="secondary" className="text-sm px-3 py-1">Nooit uitgevoerd</Badge>;
      default: return <Badge>{state}</Badge>;
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Connect Synchronisatie</h1>
        <p className="text-slate-500 mt-1">Beheer eenrichtings-sync van Connect naar de lokale Finance omgeving.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              Sync Adapter Status
            </CardTitle>
            <CardDescription>Huidige conditie van de koppeling.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {status && (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between py-3 border-b border-slate-100 dark:border-slate-800">
                  <span className="text-sm font-medium text-slate-500">Connectiestatus</span>
                  {getStatusBadge(status.state)}
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                    <p className="text-xs text-slate-500 mb-1">Laatste poging</p>
                    <p className="font-medium text-sm text-slate-900 dark:text-slate-100">{formatDate(status.lastAttemptAt)}</p>
                  </div>
                  <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                    <p className="text-xs text-slate-500 mb-1">Laatste succes</p>
                    <p className="font-medium text-sm text-slate-900 dark:text-slate-100">{formatDate(status.lastSuccessAt)}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between py-3 border-t border-slate-100 dark:border-slate-800 mt-2">
                  <span className="text-sm font-medium text-slate-500">Totaal aantal pogingen</span>
                  <span className="font-mono bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded text-sm">{status.attempts}</span>
                </div>

                {status.message && status.state !== 'healthy' && (
                  <div className="bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 p-3 rounded-lg flex gap-3 text-red-800 dark:text-red-400 text-sm">
                    <FileWarning className="w-5 h-5 shrink-0" />
                    <p>{status.message}</p>
                  </div>
                )}
              </div>
            )}
          </CardContent>
          <CardFooter className="bg-slate-50 dark:bg-slate-900 rounded-b-lg border-t border-slate-200 dark:border-slate-800">
            <Button 
              onClick={handleRunSync} 
              disabled={runSync.isPending}
              className="w-full gap-2"
              data-testid="button-run-sync"
            >
              {runSync.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <HardDriveDownload className="w-4 h-4" />}
              {runSync.isPending ? "Bezig met synchroniseren..." : "Start Synchronisatie Nu"}
            </Button>
          </CardFooter>
        </Card>

        <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800 h-fit">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ArrowRightLeft className="w-5 h-5 text-slate-400" />
              Hoe het werkt
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-slate-600 dark:text-slate-400 space-y-4">
            <p>
              De Finance module opereert onafhankelijk van Connect om betrouwbaarheid te garanderen tijdens storingen. Data wordt via een eenrichtings-synchronisatie geïmporteerd.
            </p>
            <div className="flex items-start gap-3 p-3 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-800 dark:text-indigo-300 rounded-lg">
              <Database className="w-5 h-5 shrink-0 mt-0.5" />
              <p>Wanneer je een synchronisatie start, worden alle gewijzigde personen en administraties uit Connect overgenomen naar de lokale Finance database. Lokale toevoegingen in Finance worden niet overschreven.</p>
            </div>
            <p>
              Synchronisatie is ontworpen om idempotent te zijn en kan veilig meermaals worden uitgevoerd zonder duplicaten te creëren.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}