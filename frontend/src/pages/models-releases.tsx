import { PageHeader } from '@/components/ui/page-header';
import { useTenant } from '@/context/tenant';
import { Releases } from '@/pages/learning';

export function ModelsReleasesPage() {
  const { tenant } = useTenant();
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Models & releases"
        title="Models & releases"
        description="See which model and knowledge changes are active, test candidates before publishing, and roll back safely when needed."
      />
      {tenant ? (
        <Releases clientId={tenant.id} />
      ) : (
        <p className="text-sm text-muted-foreground">Choose a company to see its releases.</p>
      )}
    </div>
  );
}
