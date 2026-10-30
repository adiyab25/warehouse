'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { createRoleAction, saveRolePermissionsAction } from '@/app/(app)/roles/actions';
import { t, type Lang } from '@/i18n';
import { ADMIN_REFUSAL_MESSAGE_KEYS, groupPermissions, type AdminRefusal, type PermissionInfo, type RoleSummary } from '../schema';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/modules/shell/ui/PageHeader';

/**
 * THE ROLES SCREEN — create a role, and decide what it may do.
 *
 * The screen edits ONE role at a time and sends the WHOLE permission set on
 * save: a diff would have to guess what an unticked box means when two tabs are
 * open, and "the set I am looking at" is the only thing a person can actually
 * confirm.
 *
 * A refusal is shown as the server's CODE, translated here — never as a generic
 * failure, because "you would lock yourself out" and "that name is not usable"
 * are different problems with different fixes.
 */

export interface RolesScreenProps {
  lang: Lang;
  roles: RoleSummary[];
  permissions: PermissionInfo[];
}

export function RolesScreen({ lang, roles, permissions }: RolesScreenProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [selectedId, setSelectedId] = useState<string>(roles[0]?.id ?? '');
  const selected = roles.find((role) => role.id === selectedId) ?? null;

  const [draft, setDraft] = useState<string[]>(selected?.permissionKeys ?? []);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const groups = useMemo(() => groupPermissions(permissions), [permissions]);

  function select(role: RoleSummary) {
    setSelectedId(role.id);
    setDraft(role.permissionKeys);
    setMessage(null);
  }

  function toggle(key: string, on: boolean) {
    setDraft((current) =>
      on ? [...new Set([...current, key])] : current.filter((candidate) => candidate !== key),
    );
  }

  async function save() {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    const answer = await saveRolePermissionsAction({ roleId: selected.id, keys: draft });
    setBusy(false);
    if (answer.ok) {
      setMessage(t('admin.roles.saved', lang));
      startTransition(() => router.refresh());
    } else {
      setMessage(t(ADMIN_REFUSAL_MESSAGE_KEYS[answer.code as AdminRefusal], lang));
    }
  }

  async function create() {
    setBusy(true);
    setMessage(null);
    const answer = await createRoleAction({ name, description, keys: [] });
    setBusy(false);
    if (answer.ok) {
      setName('');
      setDescription('');
      setMessage(t('admin.roles.created', lang));
      startTransition(() => router.refresh());
    } else {
      setMessage(t(ADMIN_REFUSAL_MESSAGE_KEYS[answer.code as AdminRefusal], lang));
    }
  }

  return (
    <>
      <PageHeader
        title={t('admin.roles.title', lang)}
        subtitle={t('admin.roles.subtitle', lang)}
        actions={
          <Button onClick={save} disabled={busy || pending || !selected}>
            {t('admin.roles.save', lang)}
          </Button>
        }
      />

      {message && (
        <p className="mb-3 rounded-md border px-3 py-2 text-sm" role="status">
          {message}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('admin.roles.list', lang)}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {roles.map((role) => (
              <button
                key={role.id}
                type="button"
                onClick={() => select(role)}
                className={
                  'flex w-full items-center justify-between rounded-md px-2 py-2 text-start text-sm ' +
                  (role.id === selectedId ? 'bg-accent text-accent-foreground' : 'hover:bg-muted')
                }
              >
                <span className="font-medium">{role.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t('admin.roles.holders', { lang, params: { count: role.userCount } })}
                </span>
              </button>
            ))}

            <div className="mt-4 space-y-2 border-t pt-3">
              <Label htmlFor="role-name">{t('admin.roles.name', lang)}</Label>
              <Input
                id="role-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('admin.roles.name_hint', lang)}
              />
              <Label htmlFor="role-description">{t('admin.roles.description', lang)}</Label>
              <Input
                id="role-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <Button variant="secondary" className="w-full" onClick={create} disabled={busy || name.trim() === ''}>
                {t('admin.roles.create', lang)}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {selected ? selected.name : t('admin.roles.select_hint', lang)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {selected &&
              groups.map((group) => (
                <div key={group.module} className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(`admin.module.${group.module}`, lang)}
                  </p>
                  {group.items.map((permission) => (
                    <label
                      key={permission.key}
                      className="flex items-start gap-2 text-sm"
                      htmlFor={`perm-${permission.key}`}
                    >
                      <Checkbox
                        id={`perm-${permission.key}`}
                        checked={draft.includes(permission.key)}
                        onCheckedChange={(checked) => toggle(permission.key, checked === true)}
                      />
                      <span>
                        <span className="ltr-value">{permission.key}</span>
                        <span className="block text-xs text-muted-foreground">
                          {permission.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
