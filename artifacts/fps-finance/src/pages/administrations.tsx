import { useListFinanceAdministrations } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, Search, Link as LinkIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState } from "react";

export default function Administrations() {
  const { data: administrations, isLoading } = useListFinanceAdministrations();
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

  const filtered = administrations?.filter(a => 
    a.name.toLowerCase().includes(search.toLowerCase()) || 
    a.shortName.toLowerCase().includes(search.toLowerCase())
  ) || [];

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Administraties</h1>
          <p className="text-slate-500 mt-1">Beheer van lokale en gekoppelde bedrijfsadministraties.</p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input 
            placeholder="Zoek administratie..." 
            className="pl-9 bg-white dark:bg-slate-900 border-slate-200"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search-admin"
          />
        </div>
      </div>

      <Card className="border-none shadow-sm ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-50 dark:bg-slate-900/50">
            <TableRow className="border-slate-200 dark:border-slate-800">
              <TableHead className="w-[300px]">Naam</TableHead>
              <TableHead>Korte Naam</TableHead>
              <TableHead>Bron</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-12 text-slate-500">
                  <div className="flex flex-col items-center justify-center space-y-3">
                    <Building2 className="w-10 h-10 text-slate-300" />
                    <p>Geen administraties gevonden.</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((admin) => (
                <TableRow key={admin.id} className="border-slate-100 dark:border-slate-800/50" data-testid={`row-admin-${admin.id}`}>
                  <TableCell className="font-medium text-slate-900 dark:text-slate-100">
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-xs dark:bg-blue-900/40 dark:text-blue-400">
                        {admin.name.charAt(0)}
                      </div>
                      {admin.name}
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-500 font-mono text-sm">{admin.shortName}</TableCell>
                  <TableCell>
                    {admin.source === 'connect' ? (
                      <Badge variant="outline" className="flex w-fit items-center gap-1.5 text-xs text-slate-600 bg-slate-50">
                        <LinkIcon className="w-3 h-3" /> Connect Sync
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs text-indigo-600 bg-indigo-50 border-indigo-100">
                        Lokaal (Finance)
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={admin.active ? "success" : "secondary"} className="font-medium">
                      {admin.active ? 'Actief' : 'Inactief'}
                    </Badge>
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