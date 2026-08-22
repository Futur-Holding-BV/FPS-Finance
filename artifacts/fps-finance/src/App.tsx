import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setBaseUrl } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Layout } from '@/components/layout';
import Login from '@/pages/login';
import Dashboard from '@/pages/dashboard';
import Administrations from '@/pages/administrations';
import People from '@/pages/people';
import SalesInvoices from '@/pages/sales-invoices';
import Sync from '@/pages/sync';
import ControlLog from '@/pages/control-log';
import Invitation from '@/pages/invitation';

import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

setBaseUrl(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/finance-api`);

function Router() {
  const [location] = useLocation();
  const isPublicAuth = location === '/login' || location === '/uitnodiging';

  return (
    <RoutedErrorBoundary>
      {isPublicAuth ? (
        <Switch>
          <Route path="/login" component={Login} />
          <Route path="/uitnodiging" component={Invitation} />
          <Route component={NotFound} />
        </Switch>
      ) : (
        <Layout>
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/administraties" component={Administrations} />
            <Route path="/verkoopfacturen" component={SalesInvoices} />
            <Route path="/personen" component={People} />
            <Route path="/synchronisatie" component={Sync} />
            <Route path="/controlelog" component={ControlLog} />
            <Route component={NotFound} />
          </Switch>
        </Layout>
      )}
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;