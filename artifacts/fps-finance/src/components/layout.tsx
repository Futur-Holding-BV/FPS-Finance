import { ReactNode, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, Users, Building, RefreshCw, LogOut, Loader2, Server, Database, ScrollText, FileText } from "lucide-react";
import { getFinanceMeQueryKey, getGetFinanceStatusQueryKey, useFinanceMe, useFinanceLogout, useGetFinanceStatus } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

export function Layout({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { data: me, isLoading: meLoading, isError: meError } = useFinanceMe({ query: { queryKey: getFinanceMeQueryKey(), retry: false }});
  const { data: status } = useGetFinanceStatus({ query: { queryKey: getGetFinanceStatusQueryKey(), refetchInterval: 30000 } });
  const logout = useFinanceLogout();
  const { toast } = useToast();

  useEffect(() => {
    if (!meLoading && (meError || !me) && location !== "/login") {
      setLocation("/login");
    }
  }, [location, me, meError, meLoading, setLocation]);

  if (meLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (meError || !me) {
    return null;
  }

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        setLocation("/login");
        toast({ title: "Succesvol uitgelogd", description: "Je bent nu uitgelogd uit de Finance werkruimte." });
      },
      onError: () => {
        toast({ variant: "destructive", title: "Fout", description: "Uitloggen mislukt. Probeer het opnieuw." });
      }
    });
  };

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/administraties", label: "Administraties", icon: Building },
    { href: "/verkoopfacturen", label: "Verkoopfacturen", icon: FileText },
    { href: "/personen", label: "Personen", icon: Users },
    { href: "/synchronisatie", label: "Synchronisatie", icon: RefreshCw },
    { href: "/controlelog", label: "Controlelog", icon: ScrollText },
  ];

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-slate-950 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 flex-shrink-0 border-r border-border bg-slate-900 text-slate-50 flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-slate-800">
          <div className="font-semibold text-lg flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-primary flex items-center justify-center">
              <span className="text-white text-xs font-bold font-mono">F</span>
            </div>
            FPS Finance
          </div>
        </div>
        
        <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link key={item.href} href={item.href} className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${isActive ? 'bg-primary text-primary-foreground' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}>
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800 space-y-4">
          <div className="space-y-2">
            <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Systeemstatus</div>
            {!status ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full bg-slate-800" />
                <Skeleton className="h-4 w-full bg-slate-800" />
              </div>
            ) : (
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300 flex items-center gap-1.5"><Server className="w-3 h-3"/> Service</span>
                  <Badge variant={status.service === 'online' ? 'success' : 'destructive'} className="h-5 px-1.5 text-[10px]">{status.service}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-300 flex items-center gap-1.5"><Database className="w-3 h-3"/> Database</span>
                  <Badge variant={status.database === 'connected' ? 'success' : 'destructive'} className="h-5 px-1.5 text-[10px]">{status.database}</Badge>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between bg-slate-800 rounded-md p-3">
            <div className="truncate pr-2">
              <div className="text-sm font-medium text-slate-50 truncate">{me.person.name}</div>
              <div className="text-xs text-slate-400 truncate">{me.person.email}</div>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-white hover:bg-slate-700" onClick={handleLogout} title="Uitloggen" data-testid="button-logout">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-background">
        <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-6xl mx-auto">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}