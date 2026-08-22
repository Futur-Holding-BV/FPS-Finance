import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLocation } from "wouter";
import { Shield, Loader2, AlertCircle } from "lucide-react";
import { getFinanceMeQueryKey, useFinanceLogin, useFinanceMe } from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";

const loginSchema = z.object({
  email: z.string().email("Ongeldig e-mailadres"),
  password: z.string().min(1, "Wachtwoord is verplicht"),
  secondFactor: z.string().optional(),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { data: me, isLoading: meLoading } = useFinanceMe({ query: { queryKey: getFinanceMeQueryKey(), retry: false }});
  
  const loginMutation = useFinanceLogin();

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
      secondFactor: "",
    },
  });

  useEffect(() => {
    if (me && !meLoading) {
      setLocation("/");
    }
  }, [me, meLoading, setLocation]);

  if (me && !meLoading) {
    return null;
  }

  const onSubmit = (data: LoginFormValues) => {
    loginMutation.mutate({ data }, {
      onSuccess: () => {
        toast({ title: "Succesvol ingelogd", description: "Welkom bij FPS Finance." });
        setLocation("/");
      },
      onError: (error) => {
        toast({ 
          variant: "destructive", 
          title: "Inloggen mislukt", 
          description: error.data?.error || "Controleer je inloggegevens en probeer het opnieuw." 
        });
        
      }
    });
  };

  if (meLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center justify-center text-center space-y-2">
          <div className="h-12 w-12 rounded-lg bg-primary flex items-center justify-center shadow-lg">
            <span className="text-white text-xl font-bold font-mono">F</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">FPS Finance</h1>
          <p className="text-slate-500 dark:text-slate-400">Lokale werkruimte beheer</p>
        </div>

        <Card className="border-border shadow-md">
          <CardHeader className="space-y-1 pb-4 border-b border-border">
            <CardTitle className="text-xl">Inloggen</CardTitle>
            <CardDescription>
              Meld je aan met je Finance account.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>E-mailadres</FormLabel>
                      <FormControl>
                        <Input autoComplete="email" placeholder="naam@organisatie.nl" {...field} data-testid="input-email" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Wachtwoord</FormLabel>
                      <FormControl>
                        <Input autoComplete="current-password" type="password" placeholder="••••••••" {...field} data-testid="input-password" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="secondFactor"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="flex items-center gap-2">
                        <Shield className="w-4 h-4 text-slate-500" />
                         Authenticator- of herstelcode
                      </FormLabel>
                      <FormControl>
                        <Input autoComplete="one-time-code" placeholder="000000" maxLength={6} {...field} data-testid="input-2fa" />
                      </FormControl>
                      <FormDescription>
                         Verplicht als tweestapsverificatie voor je Finance-account actief is.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button 
                  type="submit" 
                  className="w-full mt-6" 
                  disabled={loginMutation.isPending}
                  data-testid="button-submit-login"
                >
                  {loginMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Inloggen
                </Button>
              </form>
            </Form>
          </CardContent>
          <CardFooter className="bg-slate-50 dark:bg-slate-900 rounded-b-lg border-t border-border px-6 py-4">
            <div className="flex items-start gap-3 text-sm text-slate-500">
              <AlertCircle className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" />
              <p>Deze werkruimte is voor onafhankelijk beheer en vereist een specifiek lokaal Finance-account. Connect-referenties werken hier niet direct.</p>
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}