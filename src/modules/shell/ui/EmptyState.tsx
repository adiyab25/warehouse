import { Empty } from '@/components/ui/empty';

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="py-8">
      <Empty>
        <div className="text-center">
          <div className="font-medium">{title}</div>
          {description && <div className="text-sm text-muted-foreground">{description}</div>}
          {action && <div className="mt-4">{action}</div>}
        </div>
      </Empty>
    </div>
  );
}