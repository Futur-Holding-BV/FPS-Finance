import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  useFinanceAcceptInvitation,
  useFinanceCompleteInvitation,
  useFinanceInspectInvitation,
} from "@workspace/api-client-react";
import { AlertCircle, CheckCircle2, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default function Invitation() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const inspect = useFinanceInspectInvitation();
  const accept = useFinanceAcceptInvitation();
  const complete = useFinanceCompleteInvitation();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  useEffect(() => {
    if (token) inspect.mutate({ data: { token } });
  // The token is immutable for this mounted public onboarding page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const error = inspect.error?.data?.error
    ?? accept.error?.data?.error
    ?? complete.error?.data?.error;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 p-4 flex items-center justify-center">
      <Card className="w-full max-w-xl shadow-lg">
        <CardHeader>
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-white">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <CardTitle>Activeer je Finance-account</CardTitle>
          <CardDescription>
            Kies een eigen wachtwoord en koppel daarna een authenticator-app. Beide stappen zijn verplicht.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!token || error ? (
            <div className="flex gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <p>{error ?? "De uitnodigingslink bevat geen geldig token."}</p>
            </div>
          ) : inspect.isPending ? (
            <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Uitnodiging controleren…</div>
          ) : complete.isSuccess ? (
            <div className="space-y-4">
              <div className="flex gap-3 rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800">
                <CheckCircle2 className="h-5 w-5 shrink-0" />
                <p>Je wachtwoord en tweestapsverificatie zijn geactiveerd. Je kunt nu veilig inloggen.</p>
              </div>
              <Button asChild className="w-full"><Link href="/login">Naar inloggen</Link></Button>
            </div>
          ) : accept.data ? (
            <div className="space-y-5">
              <div>
                <h2 className="font-semibold">1. Voeg de setup-sleutel toe aan je authenticator</h2>
                <p className="mt-1 text-sm text-slate-500">Account: {accept.data.personLabel}</p>
                <code className="mt-3 block break-all rounded-md bg-slate-100 p-3 text-sm" data-testid="totp-setup-key">{accept.data.setupKey}</code>
                <a className="mt-2 inline-block text-sm text-primary underline" href={accept.data.otpauthUri}>Open in authenticator-app</a>
              </div>
              <div>
                <h2 className="font-semibold">2. Bewaar deze eenmalige herstelcodes offline</h2>
                <div className="mt-2 grid grid-cols-2 gap-2 rounded-md border p-3 font-mono text-sm">
                  {accept.data.recoveryCodes.map((recoveryCode) => <span key={recoveryCode}>{recoveryCode}</span>)}
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="totp-code" className="text-sm font-medium">3. Controleer met de 6-cijferige code</label>
                <Input id="totp-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} data-testid="input-invitation-totp" />
                <Button
                  className="w-full"
                  disabled={code.length !== 6 || complete.isPending}
                  onClick={() => complete.mutate({ data: { token, code } })}
                  data-testid="button-complete-invitation"
                >
                  {complete.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                  Activeer account
                </Button>
              </div>
            </div>
          ) : inspect.data ? (
            <div className="space-y-4">
              <div className="rounded-md bg-slate-100 p-3 text-sm">
                <strong>{inspect.data.name}</strong><br />{inspect.data.email}
              </div>
              <div className="space-y-2">
                <label htmlFor="new-password" className="text-sm font-medium">Nieuw wachtwoord</label>
                <Input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} data-testid="input-invitation-password" />
                <p className="text-xs text-slate-500">Minimaal 12 tekens, met hoofdletter, kleine letter, cijfer en speciaal teken.</p>
              </div>
              <Button
                className="w-full"
                disabled={password.length < 12 || accept.isPending}
                onClick={() => accept.mutate({ data: { token, password } })}
                data-testid="button-accept-invitation"
              >
                {accept.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Wachtwoord opslaan en authenticator koppelen
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}