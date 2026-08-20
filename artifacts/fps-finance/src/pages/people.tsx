import { useListFinancePeople } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Search, ShieldCheck, Mail } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { formatDate } from "@/lib/utils";

export default function People() {
  const { data: people, isLoading } = useListFinancePeople();
  const [search, setSearch] = useState("");

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-64 mb-2" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-[400px] rounded-xl" />
      </div>
    );
  }

  const filtered = people?.filter(p => 
    p.name.toLowerCase().includes(search.toLowerCase()) || 
    p.email.toLowerCase().includes(search.toLowerCase())
  ) || [];

  const getSyncStateBadge = (state: string) => {
    switch(state) {
      case 'synced': return <Badge variant="success">Gesynchroniseerd</Badge>;
      case 'pending': return <Badge variant="warning">In wachtrij</Badge>;
      case 'offline': return <Badge variant="secondary">Lokaal bewerkt</Badge>;
      default: return <Badge variant="outline">{state}</Badge>;
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Personen</h1>
          <p className="text-slate-500 mt-1">Gekoppelde Finance identiteiten en rechten.</p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input 
            placeholder="Zoek op naam of e-mail..." 
            className="pl-9 bg-white dark:bg-slate-900 border-slate-200"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search-people"
          />
        </div>
      </div>

      <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-50 dark:bg-slate-900/50">
            <TableRow className="border-slate-200 dark:border-slate-800">
              <TableHead>Persoon</TableHead>
              <TableHead>Status & Sync</TableHead>
              <TableHead>Rollen</TableHead>
              <TableHead>Veiligheid</TableHead>
              <TableHead>Laatste Update (Bron)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-slate-500">
                  <div className="flex flex-col items-center justify-center space-y-3">
                    <Users className="w-10 h-10 text-slate-300" />
                    <p>Geen personen gevonden.</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((person) => (
                <TableRow key={person.id} className="border-slate-100 dark:border-slate-800/50" data-testid={`row-person-${person.id}`}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium text-slate-900 dark:text-slate-100">{person.name}</span>
                      <span className="text-xs flex items-center gap-1 text-slate-500 mt-0.5">
                        <Mail className="w-3 h-3" /> {person.email}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1.5">
                      <Badge variant={person.employed ? "success" : "destructive"} className="text-[10px] px-1.5 py-0 h-5">
                        {person.employed ? 'In dienst' : 'Uit dienst'}
                      </Badge>
                      {getSyncStateBadge(person.syncState)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 max-w-[200px]">
                      {person.roles.length > 0 ? person.roles.map(role => (
                        <span key={role} className="inline-flex items-center rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-800 dark:bg-slate-800 dark:text-slate-300">
                          {role}
                        </span>
                      )) : <span className="text-xs text-slate-400 italic">Geen rollen</span>}
                    </div>
                  </TableCell>
                  <TableCell>
                    {person.secondFactorEnabled ? (
                      <div className="flex items-center gap-1.5 text-green-600 text-sm font-medium">
                        <ShieldCheck className="w-4 h-4" /> 2FA Actief
                      </div>
                    ) : (
                      <span className="text-slate-400 text-sm">Niet ingesteld</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-slate-500">
                    {formatDate(person.sourceUpdatedAt)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}