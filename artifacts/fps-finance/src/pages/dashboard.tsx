import { useGetFinanceDashboard } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Building, Users, RefreshCw, AlertCircle, CheckCircle2, Info, Clock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

export default function Dashboard() {
  const { data: dashboard, isLoading } = useGetFinanceDashboard();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-64 mb-2" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center border rounded-xl bg-slate-50/50">
        <AlertCircle className="w-12 h-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium">Kan dashboard niet laden</h3>
        <p className="text-sm text-muted-foreground">Er is een probleem met het ophalen van de gegevens.</p>
      </div>
    );
  }

  const stats = [
    {
      title: "Administraties",
      value: dashboard.administrationCount,
      icon: Building,
      description: "Lokaal beheerd",
      color: "text-blue-600",
      bg: "bg-blue-100 dark:bg-blue-900/20"
    },
    {
      title: "Personen",
      value: dashboard.peopleCount,
      icon: Users,
      description: "Gekoppelde identiteiten",
      color: "text-indigo-600",
      bg: "bg-indigo-100 dark:bg-indigo-900/20"
    },
    {
      title: "Wachtende Syncs",
      value: dashboard.pendingSyncCount,
      icon: RefreshCw,
      description: "Mutaties in wachtrij",
      color: dashboard.pendingSyncCount > 0 ? "text-amber-600" : "text-green-600",
      bg: dashboard.pendingSyncCount > 0 ? "bg-amber-100 dark:bg-amber-900/20" : "bg-green-100 dark:bg-green-900/20"
    }
  ];

  const getToneIcon = (tone: string) => {
    switch(tone) {
      case 'success': return <CheckCircle2 className="w-4 h-4 text-green-600" />;
      case 'warning': return <AlertCircle className="w-4 h-4 text-amber-600" />;
      default: return <Info className="w-4 h-4 text-blue-600" />;
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Dashboard</h1>
        <p className="text-slate-500 mt-1">Overzicht van de lokale Finance werkruimte.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {stats.map((stat, i) => (
          <Card key={i} className="border-none shadow-sm bg-white dark:bg-slate-900 ring-1 ring-slate-200 dark:ring-slate-800">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{stat.title}</p>
                  <p className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white">{stat.value}</p>
                </div>
                <div className={`p-3 rounded-xl ${stat.bg}`}>
                  <stat.icon className={`w-6 h-6 ${stat.color}`} />
                </div>
              </div>
              <div className="mt-4 flex items-center text-sm text-slate-500 dark:text-slate-400">
                <span>{stat.description}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Clock className="w-5 h-5 text-slate-400" />
              Recente Gebeurtenissen
            </CardTitle>
            <CardDescription>Laatste systeem en sync activiteiten.</CardDescription>
          </CardHeader>
          <CardContent>
            {dashboard.recentEvents.length === 0 ? (
              <div className="text-center py-8 text-slate-500">Geen recente gebeurtenissen.</div>
            ) : (
              <div className="space-y-6">
                {dashboard.recentEvents.map((event) => (
                  <div key={event.id} className="flex gap-4">
                    <div className="mt-0.5">{getToneIcon(event.tone)}</div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium leading-none text-slate-900 dark:text-slate-100">{event.title}</p>
                      <p className="text-sm text-slate-500 dark:text-slate-400">{event.detail}</p>
                      <p className="text-xs text-slate-400">{formatDate(event.occurredAt)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
          <CardHeader>
            <CardTitle className="text-lg">Jouw Rechten</CardTitle>
            <CardDescription>Actieve permissies in de Finance module.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {dashboard.permissions.map(perm => (
                <Badge key={perm} variant="secondary" className="px-3 py-1 font-mono text-xs">
                  {perm}
                </Badge>
              ))}
              {dashboard.permissions.length === 0 && (
                <span className="text-sm text-slate-500">Geen specifieke rechten toegewezen.</span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}